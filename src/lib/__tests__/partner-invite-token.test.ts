import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    partnerInviteToken: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    member: { findUnique: vi.fn() },
    familyGroupMember: { count: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendFamilyGroupInviteAcceptedEmail: vi.fn().mockResolvedValue(undefined),
  sendPartnerInviteClaimedEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  sendFamilyGroupInviteAcceptedEmail,
  sendPartnerInviteClaimedEmail,
} from "@/lib/email";
import {
  claimPartnerInviteToken,
  expireStalePartnerInviteTokens,
  getPartnerInviteTokenForClaim,
  listOutstandingPartnerInviteTokens,
  revokePartnerInviteToken,
} from "@/lib/partner-invite-token";
import {
  PARTNER_INVITE_TOKEN_TTL_DAYS,
  buildPartnerInviteTokenData,
  getPartnerInviteTokenExpiryDate,
} from "@/lib/partner-invite-token-policy";
import { hashActionToken } from "@/lib/action-tokens";

const RAW_TOKEN = "a".repeat(64);
const NOW = new Date("2026-07-10T00:00:00.000Z");

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pit1",
    tokenHash: hashActionToken(RAW_TOKEN),
    familyGroupId: "fg1",
    invitedEmail: "ghost@test.com",
    createdById: "inviter1",
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    confirmedAt: null,
    familyGroup: { id: "fg1", name: "Smith Family", _count: { memberships: 1 } },
    createdBy: { id: "inviter1", email: "alice@test.com" },
    ...overrides,
  };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "member1",
    email: "ghost@test.com",
    firstName: "Bob",
    lastName: "Jones",
    active: true,
    canLogin: true,
    ageTier: "ADULT",
    ...overrides,
  };
}

describe("partner-invite-token policy", () => {
  it("uses a 30-day TTL", () => {
    expect(PARTNER_INVITE_TOKEN_TTL_DAYS).toBe(30);
    const expiry = getPartnerInviteTokenExpiryDate(NOW);
    expect(expiry.getTime() - NOW.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("builds hashed, normalised token data and returns the raw token once", () => {
    const { token, data } = buildPartnerInviteTokenData({
      familyGroupId: "fg1",
      invitedEmail: "  Ghost@Test.com ",
      createdById: "inviter1",
      now: NOW,
    });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(data.tokenHash).toBe(hashActionToken(token));
    expect(data.tokenHash).not.toBe(token);
    expect(data.invitedEmail).toBe("ghost@test.com");
    expect(data.familyGroupId).toBe("fg1");
    expect(data.createdById).toBe("inviter1");
    expect(data.reminderCount).toBe(0);
    expect(data.lastSentAt).toEqual(NOW);
    expect(data.expiresAt).toEqual(getPartnerInviteTokenExpiryDate(NOW));
  });
});

describe("getPartnerInviteTokenForClaim", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid for a malformed token without touching the database", async () => {
    const view = await getPartnerInviteTokenForClaim("not-a-token");
    expect(view.status).toBe("invalid");
    expect(prisma.partnerInviteToken.findUnique).not.toHaveBeenCalled();
  });

  it("returns invalid for an unknown token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(null as never);
    const view = await getPartnerInviteTokenForClaim(RAW_TOKEN);
    expect(view.status).toBe("invalid");
  });

  it("returns claimed once the token is confirmed", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({ confirmedAt: new Date() }) as never
    );
    const view = await getPartnerInviteTokenForClaim(RAW_TOKEN);
    expect(view.status).toBe("claimed");
  });

  it("returns expired for a past expiry", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({ expiresAt: new Date(Date.now() - 1000) }) as never
    );
    const view = await getPartnerInviteTokenForClaim(RAW_TOKEN);
    expect(view.status).toBe("expired");
  });

  it("returns group_unavailable when the group is still memberless", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({
        familyGroup: { id: "fg1", name: "Smith Family", _count: { memberships: 0 } },
      }) as never
    );
    const view = await getPartnerInviteTokenForClaim(RAW_TOKEN);
    expect(view.status).toBe("group_unavailable");
  });

  it("returns claimable for a live, unexpired, unclaimed token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    const view = await getPartnerInviteTokenForClaim(RAW_TOKEN);
    expect(view.status).toBe("claimable");
    if (view.status === "claimable") {
      expect(view.invitedEmail).toBe("ghost@test.com");
      expect(view.groupName).toBe("Smith Family");
    }
  });
});

describe("claimPartnerInviteToken", () => {
  beforeEach(() => vi.clearAllMocks());

  // The transaction does the group-liveness count, the single-use consume, and
  // the membership/invite writes, so wire them all on the tx client.
  function wireClaimTransaction(
    { updateCount = 1, alreadyMember = false, groupCount = 1 } = {}
  ) {
    const txGroupCount = vi.fn().mockResolvedValue(groupCount);
    const txUpdateMany = vi.fn().mockResolvedValue({ count: updateCount });
    const txMemberFindUnique = vi
      .fn()
      .mockResolvedValue(alreadyMember ? { id: "fgm1" } : null);
    const txMemberUpsert = vi.fn().mockResolvedValue({});
    const txRequestCreate = vi.fn().mockResolvedValue({ id: "req1" });
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        partnerInviteToken: { updateMany: txUpdateMany },
        familyGroupMember: {
          count: txGroupCount,
          findUnique: txMemberFindUnique,
          upsert: txMemberUpsert,
        },
        familyGroupJoinRequest: { create: txRequestCreate },
      })
    );
    return { txGroupCount, txUpdateMany, txMemberUpsert, txRequestCreate };
  }

  it("files and accepts an ADULT_INVITE and consumes the token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(memberRow() as never);
    const { txUpdateMany, txMemberUpsert, txRequestCreate } = wireClaimTransaction();

    const result = await claimPartnerInviteToken({
      rawToken: RAW_TOKEN,
      memberId: "member1",
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.familyGroupId).toBe("fg1");
      expect(result.alreadyMember).toBe(false);
    }
    expect(txUpdateMany).toHaveBeenCalledWith({
      where: { id: "pit1", confirmedAt: null },
      data: { confirmedAt: NOW },
    });
    expect(txMemberUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { familyGroupId: "fg1", memberId: "member1", role: "MEMBER" },
      })
    );
    expect(txRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyGroupId: "fg1",
        requesterId: "inviter1",
        type: "ADULT_INVITE",
        invitedMemberId: "member1",
        status: "APPROVED",
        reviewedBy: "member1",
      }),
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FAMILY_GROUP_PARTNER_INVITE_CLAIMED" })
    );
    expect(sendFamilyGroupInviteAcceptedEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Bob Jones",
      "Smith Family"
    );
    expect(sendPartnerInviteClaimedEmail).toHaveBeenCalledWith(
      "ghost@test.com",
      "Bob",
      "Smith Family"
    );
  });

  it("rejects a signed-in member whose email does not match the invite", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      memberRow({ email: "someone-else@test.com" }) as never
    );

    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({ expiresAt: new Date(NOW.getTime() - 1000) }) as never
    );
    const result = await claimPartnerInviteToken({
      rawToken: RAW_TOKEN,
      memberId: "member1",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 410 });
  });

  it("rejects an already-claimed token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({ confirmedAt: new Date() }) as never
    );
    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a non-adult / non-login member", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      memberRow({ ageTier: "YOUTH" }) as never
    );
    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("rejects a claim into a still-memberless (unapproved) group without consuming the token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(memberRow() as never);
    const { txUpdateMany, txMemberUpsert } = wireClaimTransaction({ groupCount: 0 });

    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    // Liveness check is inside the tx and runs before the consume guard.
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(txMemberUpsert).not.toHaveBeenCalled();
  });

  it("treats a lost single-use race as already used and writes nothing", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(memberRow() as never);
    const { txMemberUpsert, txRequestCreate } = wireClaimTransaction({ updateCount: 0 });

    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(txMemberUpsert).not.toHaveBeenCalled();
    expect(txRequestCreate).not.toHaveBeenCalled();
  });

  it("is idempotent and files no duplicate invite when the member is already in the group", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(tokenRow() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(memberRow() as never);
    const { txRequestCreate } = wireClaimTransaction({ alreadyMember: true });

    const result = await claimPartnerInviteToken({ rawToken: RAW_TOKEN, memberId: "member1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyMember).toBe(true);
    // No duplicate ADULT_INVITE history row when the member already belongs.
    expect(txRequestCreate).not.toHaveBeenCalled();
  });
});

describe("expireStalePartnerInviteTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hard-deletes tokens past expiry and reports the count", async () => {
    vi.mocked(prisma.partnerInviteToken.deleteMany).mockResolvedValue({ count: 3 } as never);
    const result = await expireStalePartnerInviteTokens({ now: NOW });
    expect(result).toEqual({ deleted: 3 });
    expect(prisma.partnerInviteToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: NOW } },
    });
  });
});

describe("listOutstandingPartnerInviteTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only lists unconfirmed, unexpired invitations and shapes the rows", async () => {
    vi.mocked(prisma.partnerInviteToken.findMany).mockResolvedValue([
      {
        id: "pit1",
        invitedEmail: "ghost@test.com",
        expiresAt: NOW,
        createdAt: NOW,
        familyGroup: { id: "fg1", name: "Smith Family" },
        createdBy: { id: "inviter1", firstName: "Alice", lastName: "Smith" },
      },
    ] as never);

    const invites = await listOutstandingPartnerInviteTokens(NOW);
    expect(prisma.partnerInviteToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { confirmedAt: null, expiresAt: { gte: NOW } },
      })
    );
    expect(invites).toEqual([
      {
        id: "pit1",
        invitedEmail: "ghost@test.com",
        expiresAt: NOW,
        createdAt: NOW,
        familyGroupId: "fg1",
        familyGroupName: "Smith Family",
        createdBy: { id: "inviter1", name: "Alice Smith" },
      },
    ]);
  });
});

describe("revokePartnerInviteToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("guarded-deletes and audits an outstanding token", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue({
      id: "pit1",
      familyGroupId: "fg1",
      invitedEmail: "ghost@test.com",
      confirmedAt: null,
    } as never);
    vi.mocked(prisma.partnerInviteToken.deleteMany).mockResolvedValue({ count: 1 } as never);

    const revoked = await revokePartnerInviteToken({ tokenId: "pit1", adminMemberId: "admin1" });
    expect(revoked).toBe(true);
    expect(prisma.partnerInviteToken.deleteMany).toHaveBeenCalledWith({
      where: { id: "pit1", confirmedAt: null },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FAMILY_GROUP_PARTNER_INVITE_REVOKED" })
    );
  });

  it("returns false for a token that no longer exists", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(null as never);
    const revoked = await revokePartnerInviteToken({ tokenId: "gone", adminMemberId: "admin1" });
    expect(revoked).toBe(false);
    expect(prisma.partnerInviteToken.deleteMany).not.toHaveBeenCalled();
  });

  it("never deletes a claimed token (returns false, row survives)", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue({
      id: "pit1",
      familyGroupId: "fg1",
      invitedEmail: "ghost@test.com",
      confirmedAt: new Date(),
    } as never);

    const revoked = await revokePartnerInviteToken({ tokenId: "pit1", adminMemberId: "admin1" });
    expect(revoked).toBe(false);
    expect(prisma.partnerInviteToken.deleteMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("returns false (not 500) when a concurrent claim wins the delete race", async () => {
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue({
      id: "pit1",
      familyGroupId: "fg1",
      invitedEmail: "ghost@test.com",
      confirmedAt: null,
    } as never);
    // The guarded deleteMany finds nothing to delete because a claim set
    // confirmedAt between the read and the delete.
    vi.mocked(prisma.partnerInviteToken.deleteMany).mockResolvedValue({ count: 0 } as never);

    const revoked = await revokePartnerInviteToken({ tokenId: "pit1", adminMemberId: "admin1" });
    expect(revoked).toBe(false);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
