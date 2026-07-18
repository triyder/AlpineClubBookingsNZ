import { beforeEach, describe, expect, it, vi } from "vitest";

// #2041: checkMembershipStatus must honour BASED_ON_AGE_TIER dominance — an
// already-swept tier-exempt member (NOT_REQUIRED season row) must not be
// re-marked required by a Xero sync after a manual mid-season tier promotion.
const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  subFindUnique: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
  resolvePolicy: vi.fn(),
  requiresPaidForAgeTier: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    memberSubscription: {
      findUnique: mocks.subFindUnique,
      updateMany: mocks.updateMany,
      createMany: mocks.createMany,
    },
  },
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePolicyForMember: mocks.resolvePolicy,
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  requiresPaidSubscriptionForAgeTierFromSettings: mocks.requiresPaidForAgeTier,
}));

import { checkMembershipStatus } from "@/lib/xero-membership-sync";

describe("checkMembershipStatus BASED_ON_AGE_TIER dominance (#2041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // writeXeroDerivedSubscriptionState updates the existing row (fence matches
    // manuallyMarkedPaidAt = null), so count is 1 and it never creates.
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createMany.mockResolvedValue({ count: 0 });
  });

  it("a NOT_REQUIRED row dominates: an exempt member promoted to a requiring tier stays NOT_REQUIRED without consulting the age-tier flag", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "YOUTH", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "BASED_ON_AGE_TIER" });
    mocks.requiresPaidForAgeTier.mockResolvedValue(true); // stored YOUTH would require

    const result = await checkMembershipStatus("m1", 2026);

    expect(result.status).toBe("NOT_REQUIRED");
    expect(mocks.resolvePolicy).toHaveBeenCalledTimes(1);
    // Dominance short-circuits the tier check entirely.
    expect(mocks.requiresPaidForAgeTier).not.toHaveBeenCalled();
  });

  it("does not consult the type policy when there is no NOT_REQUIRED row (defers to the age-tier flag)", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "CHILD", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_INVOICED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.requiresPaidForAgeTier.mockResolvedValue(false); // exempt CHILD

    const result = await checkMembershipStatus("m1", 2026);

    expect(result.status).toBe("NOT_REQUIRED");
    expect(mocks.resolvePolicy).not.toHaveBeenCalled();
    expect(mocks.requiresPaidForAgeTier).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED types are byte-unchanged: a NOT_REQUIRED row does NOT dominate; the required path runs", async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: "m1", role: "USER", ageTier: "YOUTH", xeroContactId: null });
    mocks.subFindUnique.mockResolvedValue({
      status: "NOT_REQUIRED", manuallyMarkedPaidAt: null, xeroInvoiceId: null,
      xeroOnlineInvoiceUrl: null, paidAt: null,
    });
    mocks.resolvePolicy.mockResolvedValue({ subscriptionBehavior: "REQUIRED" });
    mocks.requiresPaidForAgeTier.mockResolvedValue(true);

    const result = await checkMembershipStatus("m1", 2026);

    // Required path (no Xero contact, no immutable charge invoice) returns
    // NOT_INVOICED — the dominance branch did NOT fire for a REQUIRED type.
    expect(result.status).toBe("NOT_INVOICED");
    expect(mocks.requiresPaidForAgeTier).toHaveBeenCalledTimes(1);
  });
});
