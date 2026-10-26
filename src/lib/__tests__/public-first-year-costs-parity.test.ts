import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * #4295: the Join page's first-year total must be the sum of what the invoicing
 * would charge. Both the page loader and `getEffectiveJoiningFee` /
 * `getEffectiveMembershipAnnualFee` read the same dated fee rows here, through
 * one in-memory store that answers `where` and `orderBy` as PostgreSQL would
 * (`matchesWhere`), so a precedence or date-window rule changed in one place and
 * not the other fails this test rather than showing a visitor a wrong price.
 * The age-tier exemption is decided by the invoicing's own predicate
 * (`requiresPaidSubscriptionForAgeTier`), not a copy of it.
 */
const TODAY = new Date("2027-03-31T00:00:00.000Z");
vi.mock("@/lib/club-time/server", () => ({ clubTodayDateOnlyInstant: vi.fn(async () => TODAY) }));

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
type FeeRow = { membershipTypeId: string; ageTier: string | null; amountCents: number; effectiveFrom: Date; effectiveTo: Date | null; billingBasis?: string; prorationRule?: string };
const annualRow = (row: Omit<FeeRow, "effectiveTo" | "prorationRule"> & Partial<FeeRow>): FeeRow =>
  ({ effectiveTo: null, billingBasis: "PER_MEMBER", prorationRule: "NONE", ...row });

const joiningRows: FeeRow[] = [
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 32000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "full", ageTier: "YOUTH", amountCents: 12000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "family", ageTier: null, amountCents: 36000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "life", ageTier: null, amountCents: 5000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "tiered", ageTier: "ADULT", amountCents: 20000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "tiered", ageTier: "CHILD", amountCents: 1000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  // Older row still inside its window, expired and not-yet-effective rows: the
  // newest current row must win on both sides, and the others must be ignored.
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 1, effectiveFrom: day("2019-01-01"), effectiveTo: null },
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 99900, effectiveFrom: day("2018-01-01"), effectiveTo: day("2018-12-31") },
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 41000, effectiveFrom: day("2027-04-01"), effectiveTo: null },
];
const annualRows: FeeRow[] = [
  annualRow({ membershipTypeId: "full", ageTier: "ADULT", amountCents: 7000, effectiveFrom: day("2020-01-01"), effectiveTo: day("2027-03-31") }),
  annualRow({ membershipTypeId: "full", ageTier: "ADULT", amountCents: 8500, effectiveFrom: day("2027-04-01") }),
  annualRow({ membershipTypeId: "full", ageTier: "YOUTH", amountCents: 3500, effectiveFrom: day("2020-01-01"), effectiveTo: day("2027-03-31") }),
  annualRow({ membershipTypeId: "family", ageTier: null, amountCents: 14000, effectiveFrom: day("2020-01-01"), billingBasis: "PER_FAMILY" }),
  annualRow({ membershipTypeId: "life", ageTier: null, amountCents: 7777, effectiveFrom: day("2020-01-01"), billingBasis: "NO_INVOICE", prorationRule: "REMAINING_MONTHS_INCLUSIVE" }),
  annualRow({ membershipTypeId: "tiered", ageTier: null, amountCents: 7000, effectiveFrom: day("2020-01-01") }),
];

const { matchesWhere } = await import("./support/prisma-where");

type Query = { where?: Record<string, unknown>; orderBy?: Array<Record<string, "asc" | "desc">> | Record<string, "asc" | "desc"> };
function read(rows: FeeRow[], query: Query): FeeRow[] {
  const order = (Array.isArray(query.orderBy) ? query.orderBy : query.orderBy ? [query.orderBy] : [])[0] ?? {};
  const direction = order.effectiveFrom === "asc" ? 1 : -1;
  return rows
    .filter((row) => matchesWhere(row, query.where))
    .sort((a, b) => direction * (a.effectiveFrom.getTime() - b.effectiveFrom.getTime()));
}
const store = {
  joiningFee: { findFirst: async (query: Query) => read(joiningRows, query)[0] ?? null },
  membershipAnnualFee: { findFirst: async (query: Query) => read(annualRows, query)[0] ?? null },
};

const TIER_SETTINGS = [
  { tier: "CHILD", label: "Child", sortOrder: 0, minAge: 0, maxAge: 9, subscriptionRequiredForBooking: false },
  { tier: "YOUTH", label: "Youth", sortOrder: 1, minAge: 10, maxAge: 17, subscriptionRequiredForBooking: true },
  { tier: "ADULT", label: "Adult", sortOrder: 2, minAge: 18, maxAge: null, subscriptionRequiredForBooking: true },
];
const TYPES = [
  { id: "full", key: "FULL", name: "Full", ageGroupsApply: true, subscriptionBehavior: "REQUIRED" },
  { id: "family", key: "FAMILY", name: "Family", ageGroupsApply: true, subscriptionBehavior: "REQUIRED" },
  { id: "life", key: "LIFE", name: "Life", ageGroupsApply: false, subscriptionBehavior: "REQUIRED" },
  { id: "tiered", key: "TIERED", name: "Tiered", ageGroupsApply: true, subscriptionBehavior: "BASED_ON_AGE_TIER" },
];

const mocks = vi.hoisted(() => ({ settings: vi.fn(), membershipTypes: vi.fn(), ageTiers: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  membershipType: { findMany: mocks.membershipTypes },
  ageTierSetting: { findMany: mocks.ageTiers },
} }));

import { getEffectiveJoiningFee, getEffectiveMembershipAnnualFee } from "@/lib/authoritative-fees";
import { requiresPaidSubscriptionForAgeTier } from "@/lib/policies/subscription";
import { loadPublicFirstYearCosts } from "@/lib/public-first-year-costs";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type Select = { joiningFees: Query; annualFees: Query };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Object.fromEntries(Object.keys(select).map((key) => [key, true])),
  );
  mocks.ageTiers.mockResolvedValue(TIER_SETTINGS);
  mocks.membershipTypes.mockImplementation(async ({ select }: { select: Select }) =>
    TYPES.map((type) => ({
      ...type,
      joiningFees: read(joiningRows.filter((row) => row.membershipTypeId === type.id), select.joiningFees),
      annualFees: read(annualRows.filter((row) => row.membershipTypeId === type.id), select.annualFees),
    })),
  );
});

describe("first-year costs agree with the invoicing resolvers (#4295)", () => {
  const cases = [
    { label: "Full — Youth", membershipTypeId: "full", ageTier: "YOUTH" as const },
    { label: "Full — Adult", membershipTypeId: "full", ageTier: "ADULT" as const },
    { label: "Family", membershipTypeId: "family", ageTier: null },
    { label: "Life", membershipTypeId: "life", ageTier: null },
    { label: "Tiered — Adult", membershipTypeId: "tiered", ageTier: "ADULT" as const },
    { label: "Tiered — Child", membershipTypeId: "tiered", ageTier: "CHILD" as const },
  ];

  it.each(cases)("$label equals the resolved joining fee plus the subscription the invoicing would charge", async ({ label, membershipTypeId, ageTier }) => {
    const joining = await getEffectiveJoiningFee({ membershipTypeId, ageTier }, TODAY, store as never);
    const annual = await getEffectiveMembershipAnnualFee({ membershipTypeId, ageTier }, TODAY, store as never);
    const type = TYPES.find((candidate) => candidate.id === membershipTypeId)!;
    const exempt =
      type.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
      !requiresPaidSubscriptionForAgeTier(ageTier, TIER_SETTINGS as never) &&
      (!annual || annual.billingBasis === "PER_MEMBER");
    const charged = !annual || exempt || annual.billingBasis === "NO_INVOICE" ? 0 : annual.amountCents;
    const expected = (joining.amountCents ?? 0) + charged;

    const groups = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST);
    const found = groups.flatMap((group) => group.rows).find((candidate) => candidate.label === label);
    expect(found?.fee.amountCents).toBe(expected);
  });

  it("pins the figures themselves, so a fixture drift cannot make the comparison vacuous", async () => {
    const [group] = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST);
    expect(Object.fromEntries(group.rows.map((r) => [r.label, r.fee.amountCents]))).toEqual({
      "Full — Youth": 15500,
      "Full — Adult": 39000,
      "Tiered — Child": 1000,
      "Tiered — Adult": 27000,
      Family: 50000,
      Life: 5000,
    });
  });
});
