import type { AgeTier } from "@prisma/client";
import { prisma } from "./prisma";
import {
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartDate,
} from "./age-tier";
import { getSeasonYear } from "./utils";
import {
  sendAgeUpInvitationEmail,
  sendAgeUpParentEmailHandoffEmail,
} from "./email";
import logger from "./logger";
import { issueActionToken } from "./action-tokens";
import { triggerMemberXeroContactGroupSync } from "./xero-contact-groups";

const AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION =
  "member.age_up.parent_email_handoff_sent";

type AgeUpUpgradeResult = {
  token: string;
  tokenHash: string;
  previousAgeTier: AgeTier;
  previousInheritEmailFromId: string | null;
  previousInheritParentEmail: boolean;
};

async function rollbackAgeUpUpgrade(
  memberId: string,
  upgrade: Pick<
    AgeUpUpgradeResult,
    | "tokenHash"
    | "previousAgeTier"
    | "previousInheritEmailFromId"
    | "previousInheritParentEmail"
  >
) {
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({
      where: {
        memberId,
        tokenHash: upgrade.tokenHash,
        used: false,
      },
    });

    await tx.member.updateMany({
      where: {
        id: memberId,
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: upgrade.previousAgeTier,
        inheritEmailFromId: upgrade.previousInheritEmailFromId,
        inheritParentEmail: upgrade.previousInheritParentEmail,
      },
    });
  });
}

type EmailHandoffSource = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

type AgeUpCandidate = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  parentMemberId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  inheritEmailFrom: EmailHandoffSource | null;
  parent: EmailHandoffSource | null;
};

type AgeUpParentEmailHandoffReason =
  | "inheritEmailFrom"
  | "legacyParentEmail"
  | "sharedLoginEmail";

type AgeUpParentEmailHandoff = {
  reason: AgeUpParentEmailHandoffReason;
  recipientEmail: string;
  recipientName: string;
  sourceMemberId: string | null;
};

function memberFullName(member: Pick<AgeUpCandidate, "firstName" | "lastName">) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

function sourceFullName(source: EmailHandoffSource | null | undefined) {
  if (!source) return "there";
  return (
    [source.firstName, source.lastName].filter(Boolean).join(" ").trim() ||
    "there"
  );
}

async function resolveAgeUpParentEmailHandoff(
  member: AgeUpCandidate
): Promise<AgeUpParentEmailHandoff | null> {
  if (member.inheritEmailFromId) {
    return {
      reason: "inheritEmailFrom",
      recipientEmail: member.inheritEmailFrom?.email ?? member.email,
      recipientName: sourceFullName(member.inheritEmailFrom),
      sourceMemberId: member.inheritEmailFromId,
    };
  }

  if (member.inheritParentEmail && member.parentMemberId) {
    return {
      reason: "legacyParentEmail",
      recipientEmail: member.parent?.email ?? member.email,
      recipientName: sourceFullName(member.parent),
      sourceMemberId: member.parentMemberId,
    };
  }

  const sharedLoginMember = await prisma.member.findFirst({
    where: {
      id: { not: member.id },
      email: member.email,
      canLogin: true,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!sharedLoginMember) {
    return null;
  }

  return {
    reason: "sharedLoginEmail",
    recipientEmail: sharedLoginMember.email,
    recipientName: sourceFullName(sharedLoginMember),
    sourceMemberId: sharedLoginMember.id,
  };
}

async function hasAgeUpParentEmailHandoffAudit(memberId: string) {
  const existingHandoff = await prisma.auditLog.findFirst({
    where: {
      action: AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION,
      subjectMemberId: memberId,
      outcome: "success",
    },
    select: { id: true },
  });

  return Boolean(existingHandoff);
}

async function recordAgeUpParentEmailHandoffAudit(params: {
  member: AgeUpCandidate;
  handoff: AgeUpParentEmailHandoff;
  targetAgeTierLabel: string;
  targetAgeTierMinAge: number;
}) {
  const youthName = memberFullName(params.member);

  await prisma.auditLog.create({
    data: {
      action: AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION,
      targetId: params.member.id,
      subjectMemberId: params.member.id,
      entityType: "Member",
      entityId: params.member.id,
      category: "communication",
      severity: "info",
      outcome: "success",
      summary: `Age-up email handoff sent for ${youthName}`,
      metadata: {
        handoffReason: params.handoff.reason,
        recipientEmail: params.handoff.recipientEmail,
        sourceMemberId: params.handoff.sourceMemberId,
        targetAgeTier: "ADULT",
        targetAgeTierLabel: params.targetAgeTierLabel,
        targetAgeTierMinAge: params.targetAgeTierMinAge,
      },
    },
  });
}

/**
 * Daily cron: detect members who have reached the configured ADULT age tier
 * at the season reference date and invite them to set up their own login.
 *
 * Criteria:
 *  - active: true
 *  - canLogin: false
 *  - ageTier: not ADULT
 *  - dateOfBirth indicates ADULT age tier at season start (April 1)
 *
 * For each qualifying member:
 *  1. Send a parent/source handoff if the member still shares a login email
 *  2. Otherwise update ageTier → ADULT, canLogin → true
 *  3. Create a password reset token (so they can set a password)
 *  4. Send age-up invitation email
 *  5. Roll back the upgrade/token if email delivery fails so the next run can retry
 *
 * Idempotency: members who already have canLogin=true are excluded.
 * EmailLog deduplication: we check for a prior "age-up-invitation" email to
 * the same member to avoid re-sending if the cron runs multiple times.
 */
export async function checkAgeUpMembers(): Promise<{
  processed: number;
  upgraded: number;
  handoff: number;
  skipped: number;
  failed: number;
}> {
  const seasonYear = getSeasonYear();
  const seasonStart = getSeasonStartDate(seasonYear);
  const ageTierSettings = await getAgeTierSettings();
  const adultAgeTierSetting = ageTierSettings.find(
    (setting) => setting.tier === "ADULT"
  );
  const targetAgeTierLabel = adultAgeTierSetting?.label ?? "Adult (18+)";
  const targetAgeTierMinAge = adultAgeTierSetting?.minAge ?? 18;

  // Find non-login members whose DOB puts them in the ADULT tier on season start.
  // We compute the cutoff DOB from the configured ADULT minimum age.
  const cutoffDate = new Date(seasonStart);
  cutoffDate.setFullYear(cutoffDate.getFullYear() - targetAgeTierMinAge);

  const candidates = await prisma.member.findMany({
    where: {
      active: true,
      canLogin: false,
      // NOT_APPLICABLE is the organisation/school tier (#1440): those
      // records have no age and must never be aged up, even if someone has
      // entered a date of birth on one.
      ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] },
      dateOfBirth: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      parentMemberId: true,
      inheritParentEmail: true,
      inheritEmailFromId: true,
      inheritEmailFrom: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
      parent: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
    },
  });

  let upgraded = 0;
  let handoff = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of candidates) {
    let upgradeResult: AgeUpUpgradeResult | null = null;

    try {
      // Double-check the age tier (belt-and-suspenders with the DB query)
      if (!member.dateOfBirth) {
        skipped++;
        continue;
      }
      const computedAgeTier = computeAgeTierWithSettings(
        member.dateOfBirth,
        seasonStart,
        ageTierSettings
      );
      if (computedAgeTier !== "ADULT") {
        skipped++;
        continue;
      }

      const parentEmailHandoff = await resolveAgeUpParentEmailHandoff(member);
      if (parentEmailHandoff) {
        const alreadyHandedOff = await hasAgeUpParentEmailHandoffAudit(member.id);
        if (alreadyHandedOff) {
          skipped++;
          continue;
        }

        await sendAgeUpParentEmailHandoffEmail(
          parentEmailHandoff.recipientEmail,
          {
            recipientName: parentEmailHandoff.recipientName,
            memberFirstName: member.firstName,
            memberLastName: member.lastName,
            targetAgeTier: "ADULT",
            targetAgeTierLabel,
            targetAgeTierMinAge,
          }
        );

        await recordAgeUpParentEmailHandoffAudit({
          member,
          handoff: parentEmailHandoff,
          targetAgeTierLabel,
          targetAgeTierMinAge,
        });

        handoff++;
        logger.info(
          {
            memberId: member.id,
            firstName: member.firstName,
            handoffReason: parentEmailHandoff.reason,
          },
          "Age-up: parent email handoff sent; member login not enabled"
        );
        continue;
      }

      // Check if we already sent an age-up email to this member
      const alreadySent = await prisma.emailLog.findFirst({
        where: {
          to: member.email,
          templateName: "age-up-invitation",
          status: { in: ["SENT", "QUEUED"] },
        },
      });
      if (alreadySent) {
        skipped++;
        continue;
      }

      upgradeResult = await prisma.$transaction(async (tx) => {
        const currentMember = await tx.member.findUnique({
          where: { id: member.id },
          select: {
            canLogin: true,
            ageTier: true,
            inheritEmailFromId: true,
            inheritParentEmail: true,
            parentMemberId: true,
          },
        });
        if (
          !currentMember ||
          currentMember.canLogin ||
          currentMember.ageTier === "ADULT" ||
          currentMember.inheritEmailFromId ||
          (currentMember.inheritParentEmail && currentMember.parentMemberId)
        ) {
          return null;
        }

        await tx.member.update({
          where: { id: member.id },
          data: {
            canLogin: true,
            ageTier: "ADULT",
            inheritEmailFromId: null,
            inheritParentEmail: false,
          },
        });

        const { token, tokenHash } = issueActionToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await tx.passwordResetToken.create({
          data: {
            tokenHash,
            memberId: member.id,
            expiresAt,
          },
        });

        return {
          token,
          tokenHash,
          previousAgeTier: currentMember.ageTier,
          previousInheritEmailFromId: currentMember.inheritEmailFromId,
          previousInheritParentEmail: currentMember.inheritParentEmail,
        };
      });
      if (!upgradeResult) {
        skipped++;
        continue;
      }

      // Send invitation email (fire-and-forget style within the loop)
      await sendAgeUpInvitationEmail(
        member.email,
        member.firstName,
        upgradeResult.token,
        {
          targetAgeTier: "ADULT",
          targetAgeTierLabel,
          targetAgeTierMinAge,
        }
      );
      upgradeResult = null;

      upgraded++;
      logger.info(
        { memberId: member.id, firstName: member.firstName },
        "Age-up: member upgraded to ADULT with login"
      );

      // Best-effort Xero contact-group re-sync after the tier flip (E8, #1934).
      // Non-fatal and idempotent on re-run; a no-op unless grouping is enabled
      // and the member has a Xero contact. Without this, a cron-aged member
      // would stay in their old age-tier group under Type+Age until some other
      // touch. Runs after the flip has durably committed, outside any DB tx.
      await triggerMemberXeroContactGroupSync(member.id, {
        reason: "cron_age_up",
      });
    } catch (err) {
      if (upgradeResult) {
        try {
          await rollbackAgeUpUpgrade(member.id, upgradeResult);
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, memberId: member.id },
            "Age-up: failed to roll back member upgrade after email failure"
          );
        }
      }

      failed++;
      logger.error(
        { err, memberId: member.id },
        "Age-up: failed to process member"
      );
    }
  }

  return {
    processed: candidates.length,
    upgraded,
    handoff,
    skipped,
    failed,
  };
}
