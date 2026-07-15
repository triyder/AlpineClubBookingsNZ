import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { findUnique: vi.fn() },
  coverage: { findMany: vi.fn() },
  members: { findMany: vi.fn() },
  membershipTypes: { findMany: vi.fn() },
  charges: { findMany: vi.fn() },
  effectiveFee: vi.fn(),
  familyMode: vi.fn(),
  mapping: vi.fn(),
}));

vi.mock("@/lib/authoritative-fees", () => ({
  getEffectiveMembershipAnnualFee: mocks.effectiveFee,
  getFamilyBillingMode: mocks.familyMode,
}));
vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.mapping,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionBillingSettings: mocks.settings,
    membershipSubscriptionChargeCoverage: mocks.coverage,
    member: mocks.members,
    membershipType: mocks.membershipTypes,
    membershipSubscriptionCharge: mocks.charges,
  },
}));

import {
  buildSubscriptionBillingPreview,
  calculateMembershipCharge,
} from "@/lib/membership-subscription-billing";
import {
  __setFinancialYearEndMonthForTesting,
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
} from "@/lib/financial-year";

function fee(overrides: Record<string, unknown> = {}) {
  return {
    id: "fee-1",
    amountCents: 12_001,
    billingBasis: "PER_MEMBER",
    prorationRule: "REMAINING_MONTHS_INCLUSIVE",
    effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

function member(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    firstName: `First-${id}`,
    lastName: "Member",
    email: `${id}@example.test`,
    role: "USER",
    seasonalMembershipAssignments: [{
      membershipType: {
        id: "type-1",
        key: "FULL",
        name: "Full",
        subscriptionBehavior: "REQUIRED",
        annualFees: [fee()],
      },
    }],
    familyGroupMemberships: [],
    ...overrides,
  };
}

function familyMembership(recipientOverrides: Record<string, unknown> = {}) {
  return {
    familyGroupId: "family-1",
    familyGroup: {
      billingMembership: {
        familyGroupId: "family-1",
        member: {
          id: "billing-1",
          firstName: "Bill",
          lastName: "Member",
          email: "bill@example.test",
          active: true,
          archivedAt: null,
          ...recipientOverrides,
        },
      },
    },
  };
}

describe("membership subscription billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.findUnique.mockResolvedValue({ invoiceDueDays: 30 });
    mocks.coverage.findMany.mockResolvedValue([]);
    mocks.members.findMany.mockResolvedValue([]);
    mocks.membershipTypes.findMany.mockResolvedValue([]);
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.effectiveFee.mockResolvedValue(fee());
    mocks.familyMode.mockResolvedValue("BILL_FAMILY_VIA_BILLING_MEMBER");
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUB", codeExplicitlyConfigured: true });
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  });

  it("handles January-start full-year and inclusive proration bounds", () => {
    __setFinancialYearEndMonthForTesting(12);
    expect(calculateMembershipCharge({
      annualAmountCents: 12_000,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-01-01T00:00:00.000Z"),
    })).toMatchObject({
      amountCents: 12_000,
      coveredMonths: 12,
      coverageStart: new Date("2026-01-01T00:00:00.000Z"),
      coverageEnd: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(calculateMembershipCharge({
      annualAmountCents: 12_000,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-10-15T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 3_000, coveredMonths: 3 });
  });

  it("charges a full year for NONE and applies inclusive-month half-up cent proration", () => {
    expect(calculateMembershipCharge({
      annualAmountCents: 12_001,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-11-15T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 12_001, coveredMonths: 12 });

    expect(calculateMembershipCharge({
      annualAmountCents: 12_001,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-07-31T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 9_001, coveredMonths: 9 });

    expect(calculateMembershipCharge({
      annualAmountCents: 1,
      prorationRule: "REMAINING_MONTHS_INCLUSIVE",
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    })).toMatchObject({ amountCents: 1, coveredMonths: 12 });
  });

  it("rejects decisions outside the selected membership year", () => {
    expect(() => calculateMembershipCharge({
      annualAmountCents: 100,
      prorationRule: "NONE",
      seasonYear: 2026,
      decisionDate: new Date("2026-03-31T00:00:00.000Z"),
    })).toThrow("within membership year");
  });

  it("plans per-member charges and freezes configured due days", async () => {
    mocks.settings.findUnique.mockResolvedValue({ invoiceDueDays: 45 });
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview).toMatchObject({ dueDays: 45, totalCents: 9_001 });
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_MEMBER",
      annualAmountCents: 12_001,
      chargedAmountCents: 9_001,
      coveredMonths: 9,
      recipient: { id: "m1" },
      coveredMembers: [{ id: "m1" }],
      xeroAccountCode: "203",
      xeroItemCode: "SUB",
    });
  });

  it("produces one visible exception and no invoice charges when subscriptionIncome is not explicitly configured", async () => {
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: null, codeExplicitlyConfigured: false });
    mocks.members.findMany.mockResolvedValue([member("m1"), member("m2")]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toHaveLength(1);
    expect(preview.exceptions[0]).toMatchObject({
      code: "MISSING_XERO_ACCOUNT_MAPPING",
      memberId: null,
      context: { affectedChargeCount: 2 },
    });
  });

  it("groups same-family per-family coverage under the explicit active recipient", async () => {
    const annual = fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = {
      membershipType: {
        id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual],
      },
    };
    mocks.members.findMany.mockResolvedValue([
      member("m1", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [familyMembership()] }),
      member("m2", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [familyMembership()] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_FAMILY",
      familyGroupId: "family-1",
      recipient: { id: "billing-1" },
    });
    expect(preview.entries[0].coveredMembers.map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("does not create a second family invoice after the effective fee row rolls over and a late member joins", async () => {
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    mocks.charges.findMany.mockResolvedValue([{
      id: "charge-existing",
      familyGroupId: "family-1",
      membershipTypeId: "type-1",
    }]);
    mocks.members.findMany.mockResolvedValue([
      member("late", {
        familyGroupMemberships: [familyMembership()],
      }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
      memberIds: ["late"],
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions).toEqual([
      expect.objectContaining({
        code: "FAMILY_ALREADY_BILLED",
        memberId: "late",
        context: expect.objectContaining({
          existingFamilyChargeId: "charge-existing",
          membershipAnnualFeeId: "fee-new",
        }),
      }),
    ]);
  });

  it("never invoices a missing or invalid family recipient", async () => {
    const annual = fee({ billingBasis: "PER_FAMILY" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = { membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual] } };
    mocks.members.findMany.mockResolvedValue([
      member("missing", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [{ familyGroupId: "family-1", familyGroup: { billingMembership: null } }],
      }),
      member("inactive", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [familyMembership({ active: false })],
      }),
    ]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    expect(preview.exceptions.map((row) => row.code)).toEqual(["INVALID_FAMILY_RECIPIENT", "MISSING_FAMILY_RECIPIENT"]);
  });

  it("surfaces a per-family fee as a config exception under individual billing without touching the recipient path", async () => {
    mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
    const annual = fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const assignment = { membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "REQUIRED", annualFees: [annual] } };
    mocks.members.findMany.mockResolvedValue([
      // Missing recipient in family mode would raise MISSING_FAMILY_RECIPIENT.
      member("no-recipient", {
        seasonalMembershipAssignments: [assignment],
        familyGroupMemberships: [{ familyGroupId: "family-1", familyGroup: { billingMembership: null } }],
      }),
      // A member not in any family would raise MISSING_FAMILY in family mode.
      member("no-family", { seasonalMembershipAssignments: [assignment], familyGroupMemberships: [] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    // Only the mode exception; the never-infer-recipient family codes are unreachable.
    expect(preview.exceptions.map((row) => row.code)).toEqual([
      "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
      "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
    ]);
    expect(preview.exceptions.some((row) => row.code === "MISSING_FAMILY_RECIPIENT" || row.code === "INVALID_FAMILY_RECIPIENT" || row.code === "MISSING_FAMILY")).toBe(false);
  });

  it("still bills per-member charges under individual billing", async () => {
    mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_MEMBER", recipient: { id: "m1" } });
  });

  it("records missing assignment and missing effective fee as visible exceptions", async () => {
    mocks.members.findMany.mockResolvedValue([
      member("unassigned", { seasonalMembershipAssignments: [] }),
      member("no-fee", {
        seasonalMembershipAssignments: [{ membershipType: { id: "type-2", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [] } }],
      }),
    ]);
    mocks.effectiveFee.mockImplementation(async (membershipTypeId: string) => membershipTypeId === "type-2" ? null : fee());
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(preview.entries).toHaveLength(0);
    expect(new Set(preview.exceptions.map((row) => row.code))).toEqual(new Set(["MISSING_FEE_SCHEDULE", "MISSING_MEMBERSHIP_ASSIGNMENT"]));
  });

  it("uses the existing role-default membership type for a newly approved member", async () => {
    mocks.members.findMany.mockResolvedValue([member("new", { seasonalMembershipAssignments: [] })]);
    mocks.membershipTypes.findMany.mockResolvedValue([{ id: "type-full", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] }]);
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z"), memberIds: ["new"] });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ membershipTypeKey: "FULL", coveredMembers: [{ id: "new" }] });
  });

  it("snapshots explicit NO_INVOICE as zero cents rather than treating it as missing config", async () => {
    mocks.members.findMany.mockResolvedValue([
      member("life", {
        seasonalMembershipAssignments: [{
          membershipType: { id: "type-life", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" })] },
        }],
      }),
    ]);
    mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" }));
    const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
    expect(preview.exceptions).toHaveLength(0);
    expect(preview.entries[0]).toMatchObject({ billingBasis: "NO_INVOICE", annualAmountCents: 0, chargedAmountCents: 0 });
  });

  it("looks up the effective annual fee once per distinct membership type, not once per member (#1886)", async () => {
    const lifeAssignment = {
      membershipType: {
        id: "type-2", key: "LIFE", name: "Life", subscriptionBehavior: "REQUIRED", annualFees: [],
      },
    };
    mocks.members.findMany.mockResolvedValue([
      member("m1"),
      member("m2"),
      member("m3", { seasonalMembershipAssignments: [lifeAssignment] }),
    ]);
    mocks.effectiveFee.mockImplementation(async (membershipTypeId: string) =>
      membershipTypeId === "type-2" ? fee({ id: "fee-2", amountCents: 6_000 }) : fee());
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(3);
    // Deduplicating identical lookups must not change any fee value.
    expect(preview.entries.filter((entry) => entry.membershipTypeId === "type-1")
      .map((entry) => entry.annualAmountCents)).toEqual([12_001, 12_001]);
    expect(preview.entries.find((entry) => entry.membershipTypeId === "type-2"))
      .toMatchObject({ annualAmountCents: 6_000 });
    expect(mocks.effectiveFee).toHaveBeenCalledTimes(2);
    expect(mocks.effectiveFee.mock.calls.map((call) => call[0]).sort()).toEqual(["type-1", "type-2"]);
  });

  it("does not regenerate already-covered subscriptions and future fee changes alter only future previews", async () => {
    mocks.coverage.findMany.mockResolvedValue([{ memberId: "covered" }]);
    const originalMember = member("future", { seasonalMembershipAssignments: [{ membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] } }] });
    mocks.effectiveFee.mockResolvedValue(fee());
    mocks.members.findMany.mockResolvedValue([member("covered"), originalMember]);
    const first = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
    expect(first.alreadyCoveredMemberIds).toEqual(["covered"]);
    expect(first.entries).toHaveLength(1);
    const frozen = structuredClone(first.entries[0]);

    mocks.members.findMany.mockResolvedValue([member("future", { seasonalMembershipAssignments: [{ membershipType: { id: "type-1", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee({ id: "fee-2", amountCents: 24_000 })] } }] })]);
    mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-2", amountCents: 24_000 }));
    const future = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-08-01T00:00:00.000Z") });
    expect(frozen.annualAmountCents).toBe(12_001);
    expect(future.entries[0].annualAmountCents).toBe(24_000);
    expect(future.confirmationToken).not.toBe(first.confirmationToken);
  });
});
