import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFind: vi.fn(),
  coverageFindMany: vi.fn(),
  coverageFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  typeFindMany: vi.fn(),
  chargeFindMany: vi.fn(),
  chargeUpsert: vi.fn(),
  subscriptionUpsert: vi.fn(),
  subscriptionFindMany: vi.fn(),
  exceptionUpdateMany: vi.fn(),
  exceptionUpsert: vi.fn(),
  operationCount: vi.fn(),
  operationCreate: vi.fn(),
  transaction: vi.fn(),
  mapping: vi.fn(),
  fee: vi.fn(),
  familyMode: vi.fn(),
  client: null as unknown,
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: vi.fn(),
    $transaction: mocks.transaction,
    membershipSubscriptionBillingSettings: { findUnique: mocks.settingsFind },
    membershipSubscriptionChargeCoverage: { findMany: mocks.coverageFindMany, findUnique: mocks.coverageFindUnique },
    membershipSubscriptionCharge: { findMany: mocks.chargeFindMany, upsert: mocks.chargeUpsert },
    membershipBillingException: { updateMany: mocks.exceptionUpdateMany, upsert: mocks.exceptionUpsert },
    member: { findMany: mocks.memberFindMany },
    membershipType: { findMany: mocks.typeFindMany },
    memberSubscription: { upsert: mocks.subscriptionUpsert, findMany: mocks.subscriptionFindMany },
    xeroSyncOperation: { count: mocks.operationCount, create: mocks.operationCreate },
  };
  mocks.client = client;
  return { prisma: client };
});
vi.mock("@/lib/authoritative-fees", () => ({ getEffectiveMembershipAnnualFee: mocks.fee, getFamilyBillingMode: mocks.familyMode }));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: mocks.mapping }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import {
  buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview,
} from "@/lib/membership-subscription-billing";

describe("membership subscription confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsFind.mockResolvedValue({ invoiceDueDays: 30 });
    mocks.familyMode.mockResolvedValue("BILL_FAMILY_VIA_BILLING_MEMBER");
    mocks.coverageFindMany.mockResolvedValue([]);
    mocks.coverageFindUnique.mockResolvedValue(null);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([{
      id: "member-1", firstName: "Member", lastName: "One", email: "member@example.test",
      role: "USER", seasonalMembershipAssignments: [{ membershipType: {
        id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED",
      } }], familyGroupMemberships: [],
    }]);
    mocks.typeFindMany.mockResolvedValue([]);
    mocks.chargeFindMany.mockResolvedValue([]);
    mocks.fee.mockResolvedValue({
      id: "fee-1", amountCents: 12_000, billingBasis: "PER_MEMBER", prorationRule: "NONE",
    });
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUB", codeExplicitlyConfigured: true });
    mocks.subscriptionUpsert.mockResolvedValue({ id: "subscription-1", memberId: "member-1" });
    mocks.chargeUpsert.mockResolvedValue({ id: "charge-1" });
    mocks.operationCount.mockResolvedValue(0);
    mocks.operationCreate.mockResolvedValue({ id: "operation-1" });
    mocks.transaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback(mocks.client));
  });

  it("atomically snapshots the mapping and coverage, then replays to the existing charge", async () => {
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    const first = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(first.chargeIds).toEqual(["charge-1"]);
    expect(mocks.chargeUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        xeroAccountCode: "203",
        xeroItemCode: "SUB",
        chargedAmountCents: 12_000,
        coverage: { create: [{ subscriptionId: "subscription-1", memberId: "member-1", memberName: "Member One" }] },
      }),
    }));
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);

    mocks.coverageFindMany
      .mockResolvedValueOnce([{ memberId: "member-1" }])
      .mockResolvedValueOnce([{ chargeId: "charge-1" }]);
    const replay = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(replay.chargeIds).toEqual(["charge-1"]);
    expect(mocks.chargeUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
  });

  it("raises the interactive transaction timeout above Prisma's 5s default for whole-club batch runs (#1886)", async () => {
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: preview.confirmationToken,
      source: "ANNUAL_BATCH",
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const options = mocks.transaction.mock.calls[0][1] as { timeout?: number } | undefined;
    expect(options?.timeout).toBeGreaterThanOrEqual(60_000);
  });
});
