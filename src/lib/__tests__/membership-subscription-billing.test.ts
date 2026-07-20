import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { findUnique: vi.fn() },
  coverage: { findMany: vi.fn() },
  subscriptions: { findMany: vi.fn() },
  members: { findMany: vi.fn() },
  membershipTypes: { findMany: vi.fn() },
  charges: { findMany: vi.fn() },
  // #2147 FINDING 1: family-level dedup reads FamilyGroupMember rows for members
  // already billed (live invoice / active coverage) and groups them for sizes.
  familyGroupMembers: { findMany: vi.fn(), groupBy: vi.fn() },
  // #2109 FIX-4d: the closed-loop test runs the REAL getSubscriptionItemCodes
  // resolver over these fee-component rows. getSubscriptionItemCodes folds in the
  // flat subscriptionIncome item code via the module-INTERNAL
  // getResolvedAccountMapping (which reads xeroAccountMapping directly, not the
  // mocked export), so the resolver's item code is supplied here.
  feeComponents: { findMany: vi.fn() },
  accountMapping: { findUnique: vi.fn() },
  effectiveFee: vi.fn(),
  familyMode: vi.fn(),
  mapping: vi.fn(),
}));

vi.mock("@/lib/authoritative-fees", () => ({
  getEffectiveMembershipAnnualFee: mocks.effectiveFee,
  getFamilyBillingMode: mocks.familyMode,
}));
// Keep getResolvedAccountMapping mocked (billing relies on the mock), but expose
// the REAL getSubscriptionItemCodes so the #2109 FIX-4d closed-loop test can
// assert the codes billing stamps are a subset of the detection resolver output.
vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-mappings")>();
  return {
    ...actual,
    getResolvedAccountMapping: mocks.mapping,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionBillingSettings: mocks.settings,
    membershipSubscriptionChargeCoverage: mocks.coverage,
    memberSubscription: mocks.subscriptions,
    member: mocks.members,
    membershipType: mocks.membershipTypes,
    membershipSubscriptionCharge: mocks.charges,
    familyGroupMember: mocks.familyGroupMembers,
    membershipAnnualFeeComponent: mocks.feeComponents,
    xeroAccountMapping: mocks.accountMapping,
  },
}));

import {
  buildComponentLineDescription,
  buildSubscriptionBillingPreview,
  calculateMembershipCharge,
} from "@/lib/membership-subscription-billing";
import { getSubscriptionItemCodes } from "@/lib/xero-mappings";
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
    // #2067: the annual fee resolves per the member's age tier (default ADULT).
    ageTier: "ADULT",
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

function comp(overrides: Record<string, unknown> = {}) {
  return { label: "Component", amountCents: 0, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0, ...overrides };
}

function familyMembershipFor(familyGroupId: string, recipientOverrides: Record<string, unknown> = {}) {
  return {
    familyGroupId,
    familyGroup: {
      billingMembership: {
        familyGroupId,
        member: {
          id: `billing-${familyGroupId}`,
          firstName: "Bill",
          lastName: "Member",
          email: `bill-${familyGroupId}@example.test`,
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
    mocks.subscriptions.findMany.mockResolvedValue([]);
    mocks.members.findMany.mockResolvedValue([]);
    mocks.membershipTypes.findMany.mockResolvedValue([]);
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.familyGroupMembers.findMany.mockResolvedValue([]);
    mocks.familyGroupMembers.groupBy.mockResolvedValue([]);
    mocks.feeComponents.findMany.mockResolvedValue([]);
    mocks.effectiveFee.mockResolvedValue(fee());
    mocks.familyMode.mockResolvedValue("BILL_FAMILY_VIA_BILLING_MEMBER");
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUB", codeExplicitlyConfigured: true });
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  });

  // #2109 FIX-4d closed loop: drive the REAL billing line-builder for a type +
  // components fixture, collect the item codes it stamps onto invoice lines, and
  // assert every one is in the detection resolver's output (derived from the
  // same fee-component data) — so look-through detection can never miss a code
  // billing can stamp. Replaces the former hardcoded-array assertion.
  it("stamps only item codes the detection resolver also matches (closed loop)", async () => {
    const componentCodes = ["FULL-ADULT", "FULL-YOUTH"];
    const annual = fee({
      components: [
        comp({ label: "Adult", amountCents: 9_000, xeroItemCode: "FULL-ADULT", sortOrder: 0 }),
        comp({ label: "Youth", amountCents: 3_000, xeroItemCode: "FULL-YOUTH", sortOrder: 1 }),
      ],
    });
    mocks.effectiveFee.mockResolvedValue(annual);
    mocks.mapping.mockResolvedValue({ code: "203", itemCode: "SUBS", codeExplicitlyConfigured: true });
    mocks.members.findMany.mockResolvedValue([member("m1")]);
    // The same component codes + flat fallback back the detection resolver.
    mocks.feeComponents.findMany.mockResolvedValue(
      componentCodes.map((xeroItemCode) => ({ xeroItemCode })),
    );
    mocks.accountMapping.findUnique.mockResolvedValue({ code: "203", itemCode: "SUBS" });

    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-04-01T00:00:00.000Z"),
    });

    // Codes the billing pipeline actually stamped — the entry-level flat code
    // and every component-line code (both get persisted onto Xero lines).
    const stamped = new Set<string>();
    for (const entry of preview.entries) {
      if (entry.xeroItemCode) stamped.add(entry.xeroItemCode);
      for (const component of entry.components) {
        if (component.xeroItemCode) stamped.add(component.xeroItemCode);
      }
    }
    // The component overrides plus the flat fallback must all appear.
    expect(stamped).toEqual(new Set([...componentCodes, "SUBS"]));

    const detectionSet = new Set(await getSubscriptionItemCodes());
    for (const code of stamped) {
      expect(detectionSet.has(code)).toBe(true);
    }
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

  it("never invoices a subscription already PAID — manual mark-paid rows with no charge coverage (#1944)", async () => {
    // A manually marked-paid member has status PAID but NO charge-coverage row
    // (they never went through Xero billing). The sweep keys "already handled"
    // off coverage rows, so without the PAID guard this member would be
    // re-invoiced. Pin: they are skipped and produce no charge entry.
    mocks.members.findMany.mockResolvedValue([member("manual-paid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows for anyone
    mocks.subscriptions.findMany.mockResolvedValue([{ memberId: "manual-paid" }]); // PAID
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.entries.some((entry) =>
      entry.coveredMembers.some((covered) => covered.id === "manual-paid"),
    )).toBe(false);
  });

  it("skips a member holding a live Xero invoice (invoiced-but-unpaid) and surfaces them under alreadyInvoiced (#2147 D1/D3)", async () => {
    // The bug: an invoiced-but-unpaid member (real xeroInvoiceId, status
    // UNPAID/OVERDUE, NO charge-coverage row because they were billed by the
    // older Xero-sync path) passed both the coverage and PAID guards and was
    // re-billed. They must now be skipped AND listed with their invoice number.
    mocks.members.findMany.mockResolvedValue([member("invoiced-unpaid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows at all
    mocks.subscriptions.findMany.mockResolvedValue([
      { memberId: "invoiced-unpaid", status: "OVERDUE", xeroInvoiceId: "xi-1", xeroInvoiceNumber: "INV-100", member: { firstName: "Iva", lastName: "Owe" } },
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.entries.some((entry) => entry.coveredMembers.some((c) => c.id === "invoiced-unpaid"))).toBe(false);
    expect(preview.alreadyInvoiced).toEqual([
      { memberId: "invoiced-unpaid", memberName: "Iva Owe", xeroInvoiceNumber: "INV-100", status: "OVERDUE" },
    ]);
  });

  it("keeps a manually marked-paid member (PAID, null xeroInvoiceId) skipped and OUT of alreadyInvoiced (#2147 regression)", async () => {
    // The dedup predicate is ADDITIVE: a manual-PAID (cash, no invoice) member
    // is skipped by the PAID clause, but has no invoice number to show, so they
    // must NOT appear in the alreadyInvoiced list.
    mocks.members.findMany.mockResolvedValue([member("manual-paid"), member("owes")]);
    mocks.coverage.findMany.mockResolvedValue([]);
    mocks.subscriptions.findMany.mockResolvedValue([
      { memberId: "manual-paid", status: "PAID", xeroInvoiceId: null, xeroInvoiceNumber: null, member: { firstName: "First-manual-paid", lastName: "Member" } },
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "owes", name: "First-owes Member" }]);
    expect(preview.alreadyInvoiced).toEqual([]);
  });

  it("re-bills a member whose only coverage claim was released after a void (#2147)", async () => {
    // A released coverage row (releasedAt set) is excluded from the skip-set
    // query, so the member is billable again. The billing query passes
    // releasedAt: null, so a released row simply never appears in alreadyCovered.
    mocks.members.findMany.mockResolvedValue([member("re-billable")]);
    mocks.coverage.findMany.mockResolvedValue([]); // released rows filtered out by releasedAt: null
    mocks.subscriptions.findMany.mockResolvedValue([]); // link nulled by the void release
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(preview.alreadyCoveredMemberIds).toEqual([]);
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].coveredMembers).toEqual([{ id: "re-billable", name: "First-re-billable Member" }]);
    // The coverage skip-set query only counts ACTIVE (releasedAt IS NULL) claims.
    expect(mocks.coverage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ releasedAt: null }),
    }));
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

  it("re-bills a new-system PER_FAMILY family once its charge is VOIDED (coverage released) (#2147)", async () => {
    // After a NEW-system PER_FAMILY charge's Xero invoice is voided, the void
    // handler (releaseVoidedSubscriptionInvoice) keeps the charge row with
    // status VOIDED and familyGroupId intact for audit, releases coverage
    // (releasedAt set) and nulls the subscription link. The existingFamilyCharges
    // query must exclude VOIDED rows so the retained charge no longer populates
    // billedFamilyTypes — otherwise it fires FAMILY_ALREADY_BILLED and blocks the
    // family's re-bill forever, contradicting the void→re-bill design.
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    // Filter-aware mock mirrors the real DB: apply the where.status filter to a
    // fixture holding one VOIDED family charge.
    const voidedCharge = { id: "charge-voided", familyGroupId: "family-1", membershipTypeId: "type-1", status: "VOIDED" };
    mocks.charges.findMany.mockImplementation((args?: { where?: { status?: { not?: string } } }) => {
      const notStatus = args?.where?.status?.not;
      return Promise.resolve([voidedCharge].filter((charge) => (notStatus ? charge.status !== notStatus : true)));
    });
    mocks.coverage.findMany.mockResolvedValue([]); // released by the void
    mocks.subscriptions.findMany.mockResolvedValue([]); // link nulled by the void
    mocks.members.findMany.mockResolvedValue([
      member("re-billable", { familyGroupMemberships: [familyMembership()] }),
    ]);
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: 2026,
      decisionDate: new Date("2026-08-01T00:00:00.000Z"),
    });
    // The retained VOIDED charge is excluded, so the family re-bills as one entry.
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0]).toMatchObject({
      billingBasis: "PER_FAMILY",
      familyGroupId: "family-1",
      recipient: { id: "billing-1" },
    });
    expect(preview.exceptions.some((row) => row.code === "FAMILY_ALREADY_BILLED")).toBe(false);
    // The query must carry the VOIDED filter that makes this correct.
    expect(mocks.charges.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: "VOIDED" } }),
    }));
  });

  it("control: a live (non-VOIDED) PER_FAMILY charge still blocks with FAMILY_ALREADY_BILLED (#2147)", async () => {
    // Same fixture, but the charge is live (e.g. UNPAID). The VOIDED filter keeps
    // it in existingFamilyCharges, so a late-joining family member is correctly
    // blocked — proving the filter narrows only VOIDED rows, not live ones.
    const annual = fee({ id: "fee-new", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    mocks.effectiveFee.mockResolvedValue(annual);
    const liveCharge = { id: "charge-live", familyGroupId: "family-1", membershipTypeId: "type-1", status: "UNPAID" };
    mocks.charges.findMany.mockImplementation((args?: { where?: { status?: { not?: string } } }) => {
      const notStatus = args?.where?.status?.not;
      return Promise.resolve([liveCharge].filter((charge) => (notStatus ? charge.status !== notStatus : true)));
    });
    mocks.members.findMany.mockResolvedValue([
      member("late", { familyGroupMemberships: [familyMembership()] }),
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
        context: expect.objectContaining({ existingFamilyChargeId: "charge-live" }),
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
    mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) => membershipTypeId === "type-2" ? null : fee());
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
    mocks.effectiveFee.mockImplementation(async ({ membershipTypeId }: { membershipTypeId: string }) =>
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
    // #2067: the memo keys per (type, tier); every member here is ADULT, so each
    // distinct type is still resolved once. The first arg is now {membershipTypeId, ageTier}.
    expect(mocks.effectiveFee.mock.calls.map((call) => call[0].membershipTypeId).sort()).toEqual(["type-1", "type-2"]);
    expect(mocks.effectiveFee.mock.calls.every((call) => call[0].ageTier === "ADULT")).toBe(true);
  });

  describe("per-age-tier annual fees (#2067)", () => {
    it("charges each member by their own age tier's fee and memoizes per (type, tier)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("adult-1", { ageTier: "ADULT" }),
        member("adult-2", { ageTier: "ADULT" }),
        member("youth-1", { ageTier: "YOUTH" }),
      ]);
      mocks.effectiveFee.mockImplementation(async ({ ageTier }: { ageTier: string | null }) =>
        ageTier === "YOUTH"
          ? fee({ id: "fee-youth", amountCents: 6_000, prorationRule: "NONE" })
          : fee({ id: "fee-adult", amountCents: 12_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // One resolver call per (type, tier), even though two members share ADULT.
      expect(mocks.effectiveFee).toHaveBeenCalledTimes(2);
      const adultEntries = preview.entries.filter((e) => e.membershipAnnualFeeId === "fee-adult");
      const youthEntries = preview.entries.filter((e) => e.membershipAnnualFeeId === "fee-youth");
      expect(adultEntries.map((e) => e.coveredMembers[0].id).sort()).toEqual(["adult-1", "adult-2"]);
      expect(adultEntries.every((e) => e.annualAmountCents === 12_000 && e.chargedAmountCents === 12_000)).toBe(true);
      expect(youthEntries).toHaveLength(1);
      expect(youthEntries[0].annualAmountCents).toBe(6_000);
      expect(youthEntries[0].coveredMembers[0].id).toBe("youth-1");
    });

    it("falls back to the flat fee (resolver returns the same row for every tier)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("adult", { ageTier: "ADULT" }),
        member("child", { ageTier: "CHILD" }),
      ]);
      // An all-flat config: the resolver returns the flat row for every tier.
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-flat", amountCents: 10_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(2);
      expect(preview.entries.every((e) => e.membershipAnnualFeeId === "fee-flat" && e.annualAmountCents === 10_000)).toBe(true);
    });

    it("names the member's age tier in the MISSING_FEE_SCHEDULE message", async () => {
      mocks.members.findMany.mockResolvedValue([member("youth-nofee", { ageTier: "YOUTH" })]);
      mocks.effectiveFee.mockResolvedValue(null);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["MISSING_FEE_SCHEDULE"]);
      expect(preview.exceptions[0].message).toContain("YOUTH");
    });

    it("resolves NOT_APPLICABLE members to the flat fee (tier passed through unchanged)", async () => {
      mocks.members.findMany.mockResolvedValue([member("org", { ageTier: "NOT_APPLICABLE" })]);
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-flat", amountCents: 8_000, prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee).toHaveBeenCalledWith(
        expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
        expect.anything(),
        expect.anything(),
      );
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-flat", annualAmountCents: 8_000 });
    });

    it("groups a flat PER_FAMILY fee across family members of differing tiers (unchanged)", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("fam-adult", { ageTier: "ADULT", familyGroupMemberships: [familyMembership()] }),
        member("fam-child", { ageTier: "CHILD", familyGroupMemberships: [familyMembership()] }),
      ]);
      // PER_FAMILY is flat-only, so the resolver returns the same flat family fee
      // for every tier; the family grouping key ignores fee.id/tier.
      mocks.effectiveFee.mockResolvedValue(fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" }));
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].billingBasis).toBe("PER_FAMILY");
      expect(preview.entries[0].coveredMembers.map((m) => m.id).sort()).toEqual(["fam-adult", "fam-child"]);
    });
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

  describe("annual fee components (#1932, E6)", () => {
    it("charges Σ of per-component proration and exposes the multi-component ±cent divergence", async () => {
      const annual = fee({ amountCents: 6, components: [comp({ label: "Base", amountCents: 3, sortOrder: 0 }), comp({ label: "Levy", amountCents: 3, sortOrder: 1 })] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries[0].coveredMonths).toBe(9);
      // Per-component floor: floor((3*9+6)/12) = 2 each -> Σ 4. Fee-level floor
      // rounds to 5, so the multi-component total is 1 cent lower (n-1 = 1).
      expect(preview.entries[0].chargedAmountCents).toBe(4);
      expect(calculateMembershipCharge({ annualAmountCents: 6, prorationRule: "REMAINING_MONTHS_INCLUSIVE", seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") }).amountCents).toBe(5);
      expect(preview.entries[0].components).toEqual([
        expect.objectContaining({ label: "Base", annualAmountCents: 3, chargedAmountCents: 2, prorated: true, xeroAccountCode: "203", xeroItemCode: "SUB", sortOrder: 0 }),
        expect.objectContaining({ label: "Levy", annualAmountCents: 3, chargedAmountCents: 2, sortOrder: 1 }),
      ]);
      expect(preview.totalCents).toBe(4);
    });

    it("resolves a component's own account/item override, else the frozen mapping; a non-prorated component charges in full", async () => {
      const annual = fee({ amountCents: 100, prorationRule: "REMAINING_MONTHS_INCLUSIVE", components: [
        comp({ label: "Base", amountCents: 60, sortOrder: 0, prorate: true }),
        comp({ label: "Work party", amountCents: 40, sortOrder: 1, prorate: false, xeroAccountCode: "260", xeroItemCode: "WP" }),
      ] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-07-13T00:00:00.000Z") });
      expect(preview.entries[0].coveredMonths).toBe(9);
      // Base prorated: floor((60*9+6)/12)=45. Work party not prorated: 40.
      expect(preview.entries[0].components).toEqual([
        expect.objectContaining({ label: "Base", chargedAmountCents: 45, prorated: true, xeroAccountCode: "203", xeroItemCode: "SUB" }),
        expect.objectContaining({ label: "Work party", chargedAmountCents: 40, prorated: false, xeroAccountCode: "260", xeroItemCode: "WP" }),
      ]);
      expect(preview.entries[0].chargedAmountCents).toBe(85);
    });

    it("NO_INVOICE carries no components", async () => {
      const annual = fee({ id: "fee-life", amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE", components: [] });
      mocks.effectiveFee.mockResolvedValue(annual);
      mocks.members.findMany.mockResolvedValue([member("life")]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries[0]).toMatchObject({ billingBasis: "NO_INVOICE", chargedAmountCents: 0, components: [] });
    });

    it("editing components changes the confirmation-token digest (edit-between-preview-and-confirm => 409)", async () => {
      mocks.members.findMany.mockResolvedValue([member("m1")]);
      mocks.effectiveFee.mockResolvedValue(fee({ amountCents: 100, prorationRule: "NONE", components: [comp({ label: "Base", amountCents: 100, sortOrder: 0 })] }));
      const before = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      mocks.effectiveFee.mockResolvedValue(fee({ amountCents: 100, prorationRule: "NONE", components: [comp({ label: "Base", amountCents: 60, sortOrder: 0 }), comp({ label: "Levy", amountCents: 40, sortOrder: 1 })] }));
      const after = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(after.confirmationToken).not.toBe(before.confirmationToken);
    });
  });

  describe("component line description (#1932, E6)", () => {
    it("reproduces the exact legacy single-line text with pluralization for a sole component", () => {
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 1, label: "Annual membership fee", isSoleComponent: true }))
        .toBe("Full membership 2026/2027 (1 month)");
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 12, label: "Annual membership fee", isSoleComponent: true }))
        .toBe("Full membership 2026/2027 (12 months)");
    });
    it("appends the label for a multi-component line", () => {
      expect(buildComponentLineDescription({ membershipTypeName: "Full", seasonYear: 2026, coveredMonths: 9, label: "Work party fee", isSoleComponent: false }))
        .toBe("Full membership 2026/2027 (9 months) — Work party fee");
    });
  });

  describe("per-member billing family (#1932, E6)", () => {
    const familyFee = () => fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    beforeEach(() => { mocks.effectiveFee.mockResolvedValue(familyFee()); });

    it("bills the admin-selected family when a member belongs to more than one", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions).toHaveLength(0);
      expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-B", recipient: { id: "billing-family-B" } });
    });

    it("raises INVALID_BILLING_FAMILY_SELECTION for a stale selection", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((row) => row.code)).toEqual(["INVALID_BILLING_FAMILY_SELECTION"]);
    });

    it("raises AMBIGUOUS_FAMILY when the selection is unset", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: null, familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["AMBIGUOUS_FAMILY"]);
    });

    it("ignores the field for a single-group member even if set to another group", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("solo", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions).toHaveLength(0);
      expect(preview.entries[0]).toMatchObject({ familyGroupId: "family-A" });
    });

    it("still subjects the selected family to the recipient checks", async () => {
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [
          familyMembershipFor("family-A"),
          { familyGroupId: "family-B", familyGroup: { billingMembership: null } },
        ] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions.map((row) => row.code)).toEqual(["MISSING_FAMILY_RECIPIENT"]);
    });

    it("ignores the selection under individual billing (mode guard fires first)", async () => {
      mocks.familyMode.mockResolvedValue("BILL_MEMBERS_INDIVIDUALLY");
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-Z", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((row) => row.code)).toEqual(["PER_FAMILY_FEE_IN_INDIVIDUAL_MODE"]);
    });

    it("groups an already-billed selected family under FAMILY_ALREADY_BILLED (never double-covered)", async () => {
      mocks.charges.findMany.mockResolvedValue([{ id: "charge-B", familyGroupId: "family-B", membershipTypeId: "type-1" }]);
      mocks.members.findMany.mockResolvedValue([
        member("multi", { billingFamilyGroupId: "family-B", familyGroupMemberships: [familyMembershipFor("family-A"), familyMembershipFor("family-B")] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exceptions[0]).toMatchObject({ code: "FAMILY_ALREADY_BILLED", familyGroupId: "family-B" });
    });
  });

  describe("family-level dedup on a partial legacy invoice (#2147 FINDING 1)", () => {
    const familyFee = () => fee({ id: "fee-family", billingBasis: "PER_FAMILY", prorationRule: "NONE" });
    // A FamilyGroupMember blocker row: the member already holds a live season
    // invoice, so the whole family group is suppressed from a second charge.
    function blocker(memberId: string, sub: { xeroInvoiceId?: string | null; xeroInvoiceNumber?: string | null; status?: string } = {}) {
      return {
        familyGroupId: "family-1",
        memberId,
        member: {
          firstName: "Bill",
          lastName: "Member",
          subscriptions: [{
            xeroInvoiceId: sub.xeroInvoiceId ?? "xi-100",
            xeroInvoiceNumber: sub.xeroInvoiceNumber ?? "INV-100",
            status: sub.status ?? "UNPAID",
          }],
        },
      };
    }

    beforeEach(() => { mocks.effectiveFee.mockResolvedValue(familyFee()); });

    it("(a) suppresses the whole family when the billing member holds a live legacy invoice and children do not (empty charge/coverage tables)", async () => {
      // Billing member B holds live INV-100; children c1/c2 have no invoice link
      // and no charge/coverage rows. Without family-level dedup c1 would proceed,
      // resolve recipient B, and mint a SECOND family charge to B.
      mocks.charges.findMany.mockResolvedValue([]); // no family charge exists yet
      mocks.coverage.findMany.mockResolvedValue([]); // no coverage rows
      mocks.subscriptions.findMany.mockResolvedValue([
        // B is separately surfaced per-member in alreadyInvoiced (unchanged).
        { memberId: "billing-1", status: "UNPAID", xeroInvoiceId: "xi-100", xeroInvoiceNumber: "INV-100", member: { firstName: "Bill", lastName: "Member" } },
      ]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("billing-1")]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
        member("c2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // No family entry is minted at all.
      expect(preview.entries).toHaveLength(0);
      // The whole family is surfaced for audit, with the invoice-holder + number.
      expect(preview.alreadyInvoicedFamilies).toEqual([
        { familyGroupId: "family-1", holderMemberId: "billing-1", holderName: "Bill Member", xeroInvoiceNumber: "INV-100", status: "UNPAID", membersCovered: 3 },
      ]);
      // The family-level dedup query is intentionally NOT scoped to memberIds.
      expect(mocks.familyGroupMembers.findMany).toHaveBeenCalled();
    });

    it("(a') suppresses the family even for a scoped NEW_MEMBER_APPROVAL run over only a child", async () => {
      // Confirming just the child must still see the billing member's invoice on
      // the same group — the blocker query is unscoped by memberIds.
      mocks.subscriptions.findMany.mockResolvedValue([]);
      mocks.familyGroupMembers.findMany.mockResolvedValue([blocker("billing-1")]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 3 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z"), memberIds: ["c1"] });
      expect(preview.entries).toHaveLength(0);
      expect(preview.alreadyInvoicedFamilies.map((f) => f.familyGroupId)).toEqual(["family-1"]);
    });

    it("(b) re-bills the whole family as ONE charge once the invoice is voided and coverage released", async () => {
      // Post-void: link nulled, coverage released -> no blocker rows -> the group
      // is billable again and folds every member into a single family entry.
      mocks.subscriptions.findMany.mockResolvedValue([]); // B is NOT_INVOICED again
      mocks.coverage.findMany.mockResolvedValue([]); // released row excluded by releasedAt: null
      mocks.familyGroupMembers.findMany.mockResolvedValue([]); // no live invoice, no active coverage
      mocks.members.findMany.mockResolvedValue([
        member("billing-1", { familyGroupMemberships: [familyMembership()] }),
        member("c1", { familyGroupMemberships: [familyMembership()] }),
        member("c2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1", recipient: { id: "billing-1" } });
      // ONE charge covering the whole group — not a partial charge covering B only.
      expect(preview.entries[0].coveredMembers.map((m) => m.id)).toEqual(["billing-1", "c1", "c2"]);
    });

    it("(d) a family with no live invoice and no charges still bills normally (regression)", async () => {
      mocks.familyGroupMembers.findMany.mockResolvedValue([]);
      mocks.members.findMany.mockResolvedValue([
        member("m1", { familyGroupMemberships: [familyMembership()] }),
        member("m2", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].coveredMembers.map((m) => m.id)).toEqual(["m1", "m2"]);
      // groupBy is only queried when a suppression actually applies.
      expect(mocks.familyGroupMembers.groupBy).not.toHaveBeenCalled();
    });

    it("prefers a live-invoice holder as the representative and stays deterministic by memberId", async () => {
      // One group member has an active-coverage-only block (no invoice number),
      // another holds the live invoice — the invoice-holder must be surfaced.
      mocks.familyGroupMembers.findMany.mockResolvedValue([
        { familyGroupId: "family-1", memberId: "z-covered", member: { firstName: "Zoe", lastName: "Cover", subscriptions: [{ xeroInvoiceId: null, xeroInvoiceNumber: null, status: "NOT_INVOICED" }] } },
        blocker("billing-1"),
      ]);
      mocks.familyGroupMembers.groupBy.mockResolvedValue([{ familyGroupId: "family-1", _count: { memberId: 4 } }]);
      mocks.members.findMany.mockResolvedValue([
        member("c1", { familyGroupMemberships: [familyMembership()] }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.alreadyInvoicedFamilies).toEqual([
        { familyGroupId: "family-1", holderMemberId: "billing-1", holderName: "Bill Member", xeroInvoiceNumber: "INV-100", status: "UNPAID", membersCovered: 4 },
      ]);
    });
  });

  describe("BASED_ON_AGE_TIER per-tier liability (#2041)", () => {
    // Local-Date DOBs so computeAge compares calendar components against the
    // season-start reference (also a local Date) TZ-independently. Season 2026
    // FY starts 1 Apr 2026 with the default (Mar) year end; age-tier settings
    // fall back to the built-in defaults (INFANT/CHILD exempt, YOUTH/ADULT
    // require) because the prisma mock has no ageTierSetting delegate.
    function ageTierMember(
      id: string,
      overrides: { dateOfBirth?: Date | null; ageTier?: string } = {},
      typeOverrides: Record<string, unknown> = {},
    ) {
      return member(id, {
        dateOfBirth: overrides.dateOfBirth ?? null,
        ageTier: overrides.ageTier ?? "ADULT",
        seasonalMembershipAssignments: [{
          membershipType: {
            id: "type-full",
            key: "FULL",
            name: "Full",
            subscriptionBehavior: "BASED_ON_AGE_TIER",
            annualFees: [fee()],
            ...typeOverrides,
          },
        }],
      });
    }

    it("charges a Youth-at-season-start and skips a Child-at-season-start (owner boundary: 01 Apr vs 31 Mar 10th birthday)", async () => {
      mocks.members.findMany.mockResolvedValue([
        // Turns 10 on 01 Apr -> Youth for the whole 2026 season -> required.
        ageTierMember("youth-01apr", { dateOfBirth: new Date(2016, 3, 1) }),
        // Turns 10 on 31 Mar (2027, mid-season) -> still a Child at 1 Apr 2026
        // season start -> exempt all season.
        ageTierMember("child-31mar", { dateOfBirth: new Date(2017, 2, 31) }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0].coveredMembers).toEqual([
        { id: "youth-01apr", name: "First-youth-01apr Member" },
      ]);
      expect(preview.exemptMemberIds).toEqual(["child-31mar"]);
    });

    it("derives the tier from DOB at season start, never current-date age (a Child who turns 10 mid-season stays exempt)", async () => {
      // Freeze 'now' well after their 10th birthday; billing must ignore it and
      // use the 1 Apr 2026 season-start age (9 -> Child -> exempt).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
      try {
        mocks.members.findMany.mockResolvedValue([
          ageTierMember("late-birthday", { dateOfBirth: new Date(2016, 4, 1) }), // 01 May 2016 -> 9 at 1 Apr 2026
        ]);
        const preview = await buildSubscriptionBillingPreview({
          seasonYear: 2026,
          decisionDate: new Date("2026-07-13T00:00:00.000Z"),
        });
        expect(preview.entries).toHaveLength(0);
        expect(preview.exemptMemberIds).toEqual(["late-birthday"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the stored tier when DOB is unknown — ADULT default is fail-closed/required", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("no-dob-adult", { dateOfBirth: null, ageTier: "ADULT" }),
        ageTierMember("no-dob-child", { dateOfBirth: null, ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries.flatMap((entry) => entry.coveredMembers.map((m) => m.id)))
        .toEqual(["no-dob-adult"]);
      expect(preview.exemptMemberIds).toEqual(["no-dob-child"]);
    });

    it("a liable Youth mints the SAME charge a REQUIRED type would — key and amount byte-unchanged", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("youth", { dateOfBirth: new Date(2016, 3, 1) }),
      ]);
      const ageTierPreview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      mocks.members.findMany.mockResolvedValue([
        member("youth", {
          dateOfBirth: new Date(2016, 3, 1),
          ageTier: "YOUTH",
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-full", key: "FULL", name: "Full", subscriptionBehavior: "REQUIRED", annualFees: [fee()] },
          }],
        }),
      ]);
      const requiredPreview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(ageTierPreview.entries[0].key).toBe(requiredPreview.entries[0].key);
      expect(ageTierPreview.entries[0].chargedAmountCents).toBe(requiredPreview.entries[0].chargedAmountCents);
      expect(ageTierPreview.entries[0].membershipTypeId).toBe("type-full");
    });

    it("does not resolve a Xero mapping when the only members are tier-exempt (no invoice entries)", async () => {
      mocks.members.findMany.mockResolvedValue([
        ageTierMember("child", { dateOfBirth: new Date(2017, 2, 31) }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.entries).toHaveLength(0);
      expect(preview.exemptMemberIds).toEqual(["child"]);
      expect(mocks.mapping).not.toHaveBeenCalled();
    });

    it("PER_FAMILY is unchanged — an exempt Child under BASED_ON_AGE_TIER is still covered by the single family charge (Q5)", async () => {
      mocks.effectiveFee.mockResolvedValue(fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" }));
      mocks.members.findMany.mockResolvedValue([
        member("child-in-family", {
          dateOfBirth: new Date(2017, 2, 31),
          ageTier: "CHILD",
          familyGroupMemberships: [familyMembership()],
          seasonalMembershipAssignments: [{
            membershipType: { id: "type-1", key: "FAMILY", name: "Family", subscriptionBehavior: "BASED_ON_AGE_TIER", annualFees: [fee({ billingBasis: "PER_FAMILY", prorationRule: "NONE" })] },
          }],
        }),
      ]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-04-01T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual([]);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ billingBasis: "PER_FAMILY", familyGroupId: "family-1" });
    });

    it("REQUIRED-only clubs are byte-unchanged: exemptMemberIds is always empty", async () => {
      mocks.members.findMany.mockResolvedValue([member("m1"), member("m2")]);
      const preview = await buildSubscriptionBillingPreview({
        seasonYear: 2026,
        decisionDate: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(preview.exemptMemberIds).toEqual([]);
      expect(preview.entries).toHaveLength(2);
    });
  });

  describe("stored tier vs season-start tier price alignment (#2067 finding 1)", () => {
    // A BASED_ON_AGE_TIER member must be PRICED by the same season-start tier
    // that gates liability — not by the stored tier, which can drift (the age-up
    // cron only maintains the ADULT boundary, and prior-season billing
    // recomputes). Age-tier settings fall back to the built-in defaults (no
    // ageTierSetting delegate on the prisma mock): INFANT/CHILD exempt,
    // YOUTH/ADULT required; YOUTH is age 10-17 at season start.
    function basedMember(
      id: string,
      opts: { dateOfBirth?: Date | null; ageTier?: string } = {},
    ) {
      return member(id, {
        dateOfBirth: opts.dateOfBirth ?? null,
        ageTier: opts.ageTier ?? "ADULT",
        seasonalMembershipAssignments: [{
          membershipType: {
            id: "type-full",
            key: "FULL",
            name: "Full",
            subscriptionBehavior: "BASED_ON_AGE_TIER",
            annualFees: [fee()],
          },
        }],
      });
    }

    // Distinct price per tier so the resolved fee reveals which tier was used.
    function tierPricedFees() {
      const priceByTier: Record<string, number> = { CHILD: 3_000, YOUTH: 6_000, ADULT: 12_000 };
      mocks.effectiveFee.mockImplementation(async ({ ageTier }: { ageTier: string | null }) =>
        fee({ id: `fee-${ageTier}`, amountCents: priceByTier[ageTier ?? ""] ?? 9_999, prorationRule: "NONE" }));
    }

    it("stored CHILD but season-start YOUTH: charged the YOUTH price (liability tier drives the price)", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // Turns 10 on 01 Apr 2026 -> YOUTH at season start; stored tier still CHILD.
        basedMember("drifted-up", { dateOfBirth: new Date(2016, 3, 1), ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      // Resolved by the season-start tier, never the stored CHILD tier.
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries).toHaveLength(1);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000, chargedAmountCents: 6_000 });
      expect(preview.exemptMemberIds).toEqual([]);
    });

    it("stored ADULT but season-start YOUTH (prior-season billing): charged the YOUTH price, not ADULT", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // At 1 Apr 2026 season start they were 10 -> YOUTH; the stored tier has
        // since aged up to ADULT. Billing 2026 must charge the YOUTH price.
        basedMember("drifted-adult", { dateOfBirth: new Date(2016, 3, 1), ageTier: "ADULT" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("stored == season-start tier: resolves that tier unchanged (no regression)", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        basedMember("aligned-youth", { dateOfBirth: new Date(2016, 3, 1), ageTier: "YOUTH" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("non-age-based type (REQUIRED) prices by the STORED tier, ignoring DOB", async () => {
      tierPricedFees();
      mocks.members.findMany.mockResolvedValue([
        // DOB would compute ADULT at season start, but a REQUIRED type has no
        // computed tier — it must price by the stored YOUTH tier (joining-fee
        // convention). The default member() type is REQUIRED.
        member("required-youth", { ageTier: "YOUTH", dateOfBirth: new Date(1990, 0, 1) }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(mocks.effectiveFee.mock.calls.every((c) => c[0].ageTier === "YOUTH")).toBe(true);
      expect(preview.entries[0]).toMatchObject({ membershipAnnualFeeId: "fee-YOUTH", annualAmountCents: 6_000 });
    });

    it("MISSING_FEE_SCHEDULE names the season-start tier actually used, not the stored tier", async () => {
      mocks.effectiveFee.mockResolvedValue(null);
      mocks.members.findMany.mockResolvedValue([
        basedMember("no-youth-fee", { dateOfBirth: new Date(2016, 3, 1), ageTier: "CHILD" }),
      ]);
      const preview = await buildSubscriptionBillingPreview({ seasonYear: 2026, decisionDate: new Date("2026-04-01T00:00:00.000Z") });
      expect(preview.exceptions.map((r) => r.code)).toEqual(["MISSING_FEE_SCHEDULE"]);
      expect(preview.exceptions[0].message).toContain("YOUTH");
      expect(preview.exceptions[0].message).not.toContain("CHILD");
    });
  });
});
