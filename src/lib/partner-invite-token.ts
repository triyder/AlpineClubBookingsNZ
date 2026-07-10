import "server-only";

import { prisma } from "@/lib/prisma";
import { hashActionToken, isActionTokenFormat } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { normalizeInvitedEmail } from "@/lib/partner-invite-token-policy";
import {
  formPartnerLinkOnClaim,
  type ClaimPartnerLinkOutcome,
} from "@/lib/member-partner-link";
import {
  sendFamilyGroupInviteAcceptedEmail,
  sendPartnerInviteClaimedEmail,
  sendPartnerLinkConfirmedEmail,
} from "@/lib/email";

type PartnerInviteClaimView =
  | { status: "invalid" }
  | {
      status: "expired" | "claimed" | "group_unavailable" | "claimable";
      invitedEmail: string;
      groupName: string | null;
      familyGroupId: string;
      // #1742: claiming will also record the partner relationship with the
      // inviter — the claim page must disclose this before the claimer
      // consents.
      createPartnerLink: boolean;
      inviterName: string | null;
    };

/**
 * Read-only lookup used by the claim page to render state without mutating the
 * token. Returns "invalid" for a malformed or unknown token so the page copy is
 * uniform whether the link was never issued or has been consumed and pruned.
 */
export async function getPartnerInviteTokenForClaim(
  rawToken: string
): Promise<PartnerInviteClaimView> {
  if (!isActionTokenFormat(rawToken)) {
    return { status: "invalid" };
  }

  const token = await prisma.partnerInviteToken.findUnique({
    where: { tokenHash: hashActionToken(rawToken) },
    include: {
      familyGroup: {
        select: {
          id: true,
          name: true,
          _count: { select: { memberships: true } },
        },
      },
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });

  if (!token) {
    return { status: "invalid" };
  }

  const inviterName = token.createdBy
    ? `${token.createdBy.firstName} ${token.createdBy.lastName}`.trim() || null
    : null;
  const base = {
    invitedEmail: token.invitedEmail,
    groupName: token.familyGroup.name,
    familyGroupId: token.familyGroupId,
    createPartnerLink: token.createPartnerLink,
    inviterName,
  };

  if (token.confirmedAt) {
    return { status: "claimed", ...base };
  }
  if (token.expiresAt < new Date()) {
    return { status: "expired", ...base };
  }
  // A memberless family group means the GROUP_CREATE request has not been
  // approved yet (or was rejected). The invite cannot land in an unapproved
  // group, so surface it as unavailable rather than creating a membership.
  if (token.familyGroup._count.memberships === 0) {
    return { status: "group_unavailable", ...base };
  }

  return { status: "claimable", ...base };
}

export type PartnerInviteClaimResult =
  | {
      ok: true;
      familyGroupId: string;
      groupName: string | null;
      alreadyMember: boolean;
      // #1742: true when the token was minted with createPartnerLink and the
      // CONFIRMED MemberPartnerLink between inviter and claimer was formed.
      partnerLinkFormed: boolean;
    }
  | {
      ok: false;
      status: 403 | 404 | 409 | 410 | 422;
      error: string;
    };

/**
 * Consume a partner-invite token on behalf of a now-registered member. Single
 * use: the token's confirmedAt is claimed under an updateMany guard so two
 * concurrent claims cannot both file an ADULT_INVITE. The member is added to
 * the (approved) family group and the token is spent.
 */
export async function claimPartnerInviteToken(params: {
  rawToken: string;
  memberId: string;
  now?: Date;
}): Promise<PartnerInviteClaimResult> {
  const now = params.now ?? new Date();

  if (!isActionTokenFormat(params.rawToken)) {
    return { ok: false, status: 404, error: "This invitation link is invalid." };
  }

  const token = await prisma.partnerInviteToken.findUnique({
    where: { tokenHash: hashActionToken(params.rawToken) },
    include: {
      familyGroup: { select: { id: true, name: true } },
      createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });

  if (!token) {
    return { ok: false, status: 404, error: "This invitation link is invalid." };
  }
  if (token.confirmedAt) {
    return {
      ok: false,
      status: 409,
      error: "This invitation has already been used.",
    };
  }
  if (token.expiresAt < now) {
    return { ok: false, status: 410, error: "This invitation link has expired." };
  }

  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      active: true,
      canLogin: true,
      ageTier: true,
    },
  });

  if (!member) {
    return { ok: false, status: 404, error: "Member not found." };
  }
  // The claimer must be signed in with the invited email address so a forwarded
  // link cannot be used to join a stranger's family group.
  if (normalizeInvitedEmail(member.email) !== token.invitedEmail) {
    return {
      ok: false,
      status: 403,
      error: `This invitation was sent to ${token.invitedEmail}. Sign in with that account to accept it.`,
    };
  }
  if (!member.active || !member.canLogin || member.ageTier !== "ADULT") {
    return {
      ok: false,
      status: 422,
      error: "Only active adult members with a login can accept a partner invitation.",
    };
  }

  type ClaimOutcome =
    | { outcome: "group_unavailable" }
    | { outcome: "race_lost" }
    | {
        outcome: "ok";
        alreadyMember: boolean;
        partnerLink: ClaimPartnerLinkOutcome | null;
      };

  const result = await prisma.$transaction(async (tx): Promise<ClaimOutcome> => {
    // Liveness check inside the transaction so a group that was deleted or
    // emptied concurrently fails cleanly here (before consuming the token)
    // instead of racing an unlocked pre-transaction read.
    const groupMemberCount = await tx.familyGroupMember.count({
      where: { familyGroupId: token.familyGroupId },
    });
    if (groupMemberCount === 0) {
      return { outcome: "group_unavailable" };
    }

    // Single-use guard: only the first caller flips confirmedAt from null.
    const consume = await tx.partnerInviteToken.updateMany({
      where: { id: token.id, confirmedAt: null },
      data: { confirmedAt: now },
    });
    if (consume.count !== 1) {
      return { outcome: "race_lost" };
    }

    const existingMembership = await tx.familyGroupMember.findUnique({
      where: {
        familyGroupId_memberId: {
          familyGroupId: token.familyGroupId,
          memberId: member.id,
        },
      },
      select: { id: true },
    });
    const alreadyMember = Boolean(existingMembership);

    await tx.familyGroupMember.upsert({
      where: {
        familyGroupId_memberId: {
          familyGroupId: token.familyGroupId,
          memberId: member.id,
        },
      },
      create: {
        familyGroupId: token.familyGroupId,
        memberId: member.id,
        role: "MEMBER",
      },
      update: {},
    });

    // Record the join as an already-accepted ADULT_INVITE so the family-group
    // request history mirrors the registered-partner path — but only when we
    // actually add the member; an existing membership needs no duplicate row.
    if (!alreadyMember) {
      await tx.familyGroupJoinRequest.create({
        data: {
          familyGroupId: token.familyGroupId,
          requesterId: token.createdById,
          type: "ADULT_INVITE",
          invitedMemberId: member.id,
          status: "APPROVED",
          reviewedAt: now,
          reviewedBy: member.id,
        },
      });
    }

    // #1742: an opted-in token also forms the CONFIRMED partner link — the
    // claim itself is the partner's consent. A business conflict (inviter no
    // longer eligible, either side already has a confirmed partner) skips the
    // link without failing the family-group join; the outcome is audited below.
    let partnerLink: ClaimPartnerLinkOutcome | null = null;
    if (token.createPartnerLink) {
      partnerLink = await formPartnerLinkOnClaim({
        tx,
        inviterMemberId: token.createdById,
        claimerMemberId: member.id,
        now,
      });
    }

    return { outcome: "ok", alreadyMember, partnerLink };
  });

  if (result.outcome === "group_unavailable") {
    return {
      ok: false,
      status: 409,
      error: "This family group is not available. Ask the person who invited you to check their group.",
    };
  }
  if (result.outcome === "race_lost") {
    return {
      ok: false,
      status: 409,
      error: "This invitation has already been used.",
    };
  }

  const { alreadyMember, partnerLink } = result;
  const partnerLinkFormed = partnerLink?.formed === true;

  logAudit({
    action: "FAMILY_GROUP_PARTNER_INVITE_CLAIMED",
    memberId: member.id,
    targetId: token.familyGroupId,
    subjectMemberId: member.id,
    entityType: "PartnerInviteToken",
    entityId: token.id,
    category: "family",
    outcome: "success",
    summary: "Partner invitation claimed",
    details: JSON.stringify({
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
      createdById: token.createdById,
      alreadyMember,
      createPartnerLink: token.createPartnerLink,
      partnerLinkFormed,
      partnerLinkSkippedReason:
        partnerLink && !partnerLink.formed ? partnerLink.reason : null,
    }),
    metadata: {
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
      createdById: token.createdById,
      alreadyMember,
      partnerLinkFormed,
    },
  });

  if (partnerLink) {
    if (partnerLink.formed) {
      logAudit({
        action: "MEMBER_PARTNER_LINK_CONFIRMED",
        memberId: member.id,
        targetId: token.createdById,
        subjectMemberId: member.id,
        entityType: "MemberPartnerLink",
        entityId: partnerLink.linkId,
        category: "family",
        outcome: "success",
        summary: "Partner link confirmed via partner-invite claim",
        details: JSON.stringify({
          linkId: partnerLink.linkId,
          inviterMemberId: token.createdById,
          claimerMemberId: member.id,
          viaPartnerInviteTokenId: token.id,
          promotedPendingRequest: partnerLink.promoted,
        }),
        metadata: { linkId: partnerLink.linkId, viaPartnerInviteTokenId: token.id },
      });
    } else {
      logAudit({
        action: "MEMBER_PARTNER_LINK_CLAIM_SKIPPED",
        memberId: member.id,
        targetId: token.createdById,
        subjectMemberId: member.id,
        entityType: "PartnerInviteToken",
        entityId: token.id,
        category: "family",
        outcome: "failure",
        summary: "Partner link requested at mint could not be formed on claim",
        details: JSON.stringify({
          reason: partnerLink.reason,
          inviterMemberId: token.createdById,
          claimerMemberId: member.id,
        }),
        metadata: { reason: partnerLink.reason },
      });
      logger.warn(
        { tokenId: token.id, reason: partnerLink.reason },
        "Partner link skipped on partner-invite claim"
      );
    }
  }

  const inviteeName = `${member.firstName} ${member.lastName}`.trim() || "A member";
  const groupName = token.familyGroup.name ?? "your family group";

  // Notify the inviter (reuse the existing invite-accepted template).
  if (token.createdBy?.email) {
    sendFamilyGroupInviteAcceptedEmail(
      token.createdBy.email.toLowerCase(),
      inviteeName,
      groupName
    ).catch((err) => {
      logger.error(
        { err, tokenId: token.id },
        "Failed to send partner invite accepted email to inviter"
      );
    });

    if (partnerLinkFormed) {
      sendPartnerLinkConfirmedEmail(
        token.createdBy.email.toLowerCase(),
        inviteeName
      ).catch((err) => {
        logger.error(
          { err, tokenId: token.id },
          "Failed to send partner link confirmed email to inviter"
        );
      });
    }
  }

  // Welcome the newly-registered partner into the group.
  sendPartnerInviteClaimedEmail(member.email.toLowerCase(), member.firstName, groupName).catch(
    (err) => {
      logger.error(
        { err, tokenId: token.id },
        "Failed to send partner invite claimed email to invitee"
      );
    }
  );

  logger.info(
    {
      tokenId: token.id,
      memberId: member.id,
      familyGroupId: token.familyGroupId,
      alreadyMember,
      partnerLinkFormed,
    },
    "Partner invitation claimed"
  );

  return {
    ok: true,
    familyGroupId: token.familyGroupId,
    groupName: token.familyGroup.name,
    alreadyMember,
    partnerLinkFormed,
  };
}

export interface PartnerInviteTokenSweepResult {
  deleted: number;
}

/**
 * Idempotent cron sweep: hard-delete partner-invite tokens whose expiry has
 * passed. Mirrors the expired-token prunes in the data-pruning cron; safe to
 * run repeatedly (a second run simply finds nothing to delete).
 */
export async function expireStalePartnerInviteTokens({
  now = new Date(),
}: { now?: Date } = {}): Promise<PartnerInviteTokenSweepResult> {
  const result = await prisma.partnerInviteToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return { deleted: result.count };
}

/**
 * Admin list of outstanding (unconfirmed, unexpired) partner invitations.
 */
export async function listOutstandingPartnerInviteTokens(now = new Date()) {
  const tokens = await prisma.partnerInviteToken.findMany({
    where: { confirmedAt: null, expiresAt: { gte: now } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      invitedEmail: true,
      expiresAt: true,
      createdAt: true,
      familyGroup: { select: { id: true, name: true } },
      createdBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return tokens.map((token) => ({
    id: token.id,
    invitedEmail: token.invitedEmail,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    familyGroupId: token.familyGroup.id,
    familyGroupName: token.familyGroup.name,
    createdBy: token.createdBy
      ? {
          id: token.createdBy.id,
          name: `${token.createdBy.firstName} ${token.createdBy.lastName}`.trim(),
        }
      : null,
  }));
}

/**
 * Guarded delete shared by the admin revoke and the inviter's own cancel:
 * only remove the row while it is still outstanding. If a concurrent claim
 * set confirmedAt between the caller's read and here, count is 0 and we
 * return false instead of throwing (P2025) or deleting claim history.
 */
async function deleteOutstandingPartnerInviteToken(tokenId: string): Promise<boolean> {
  const deleted = await prisma.partnerInviteToken.deleteMany({
    where: { id: tokenId, confirmedAt: null },
  });
  return deleted.count > 0;
}

/**
 * Admin revocation: hard-delete a single OUTSTANDING token. Returns false when
 * there is no outstanding token to revoke — the id is unknown, the token has
 * already been claimed (confirmedAt set), or it was expired-and-swept/revoked.
 * A claimed token is never deleted, so its accepted membership history stands.
 */
export async function revokePartnerInviteToken(params: {
  tokenId: string;
  adminMemberId: string;
}): Promise<boolean> {
  const token = await prisma.partnerInviteToken.findUnique({
    where: { id: params.tokenId },
    select: { id: true, familyGroupId: true, invitedEmail: true, confirmedAt: true },
  });
  if (!token || token.confirmedAt) {
    return false;
  }

  if (!(await deleteOutstandingPartnerInviteToken(token.id))) {
    return false;
  }

  logAudit({
    action: "FAMILY_GROUP_PARTNER_INVITE_REVOKED",
    memberId: params.adminMemberId,
    targetId: token.familyGroupId,
    entityType: "PartnerInviteToken",
    entityId: token.id,
    category: "family",
    outcome: "success",
    summary: "Partner invitation revoked",
    details: JSON.stringify({
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
    }),
    metadata: {
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
    },
  });

  return true;
}

/**
 * Member-side cancellation of their own declared-partner invitation (#1754):
 * the inviter revokes an OUTSTANDING token they minted with
 * createPartnerLink, without needing an admin. Scope is deliberately narrow —
 * own token only (createdById), partner-declaring tokens only, unclaimed only
 * (a claimed token's membership history stands, exactly as in the admin
 * revoke above). Returns false when nothing matched those conditions.
 */
export async function cancelOwnPartnerInviteToken(params: {
  tokenId: string;
  memberId: string;
}): Promise<boolean> {
  const token = await prisma.partnerInviteToken.findUnique({
    where: { id: params.tokenId },
    select: {
      id: true,
      familyGroupId: true,
      invitedEmail: true,
      confirmedAt: true,
      createdById: true,
      createPartnerLink: true,
    },
  });
  if (
    !token ||
    token.confirmedAt ||
    token.createdById !== params.memberId ||
    !token.createPartnerLink
  ) {
    return false;
  }

  if (!(await deleteOutstandingPartnerInviteToken(token.id))) {
    return false;
  }

  logAudit({
    action: "FAMILY_GROUP_PARTNER_INVITE_CANCELLED",
    memberId: params.memberId,
    targetId: token.familyGroupId,
    subjectMemberId: params.memberId,
    entityType: "PartnerInviteToken",
    entityId: token.id,
    category: "family",
    outcome: "success",
    summary: "Partner invitation cancelled by the inviter",
    details: JSON.stringify({
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
      cancelledByInviter: true,
    }),
    metadata: {
      familyGroupId: token.familyGroupId,
      invitedEmail: token.invitedEmail,
      cancelledByInviter: true,
    },
  });

  return true;
}
