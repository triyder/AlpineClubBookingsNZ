import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// findUnpaidMemberGuests consults enforcement + age-tier settings + the
// membership-type policy. Mock those so we can drive the BASED_ON_AGE_TIER
// NOT_REQUIRED-row dominance (#2041) deterministically.
vi.mock("@/lib/member-subscription-eligibility", () => ({
  isSubscriptionEnforcementActive: vi.fn(async () => true),
  requiresPaidSubscriptionForAgeTier: (tier: string) =>
    tier === "YOUTH" || tier === "ADULT",
}));
vi.mock("@/lib/age-tier", () => ({ getAgeTierSettings: vi.fn(async () => []) }));

const mockResolvePolicies = vi.fn();
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers: (...args: unknown[]) =>
    mockResolvePolicies(...args),
}));

import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";

type SubRow = { memberId: string; status: SubscriptionStatus; xeroOnlineInvoiceUrl: string | null; xeroInvoiceNumber: string | null };

function makeDb(members: Array<{ id: string; ageTier: AgeTier }>, subs: SubRow[]) {
  return {
    memberSubscription: {
      findMany: vi.fn(async () => subs),
    },
    member: {
      findMany: vi.fn(async () =>
        members.map((m) => ({ id: m.id, firstName: "Guest", lastName: m.id, ageTier: m.ageTier })),
      ),
    },
  };
}

const checkIn = new Date("2026-07-13T00:00:00.000Z");

describe("findUnpaidMemberGuests BASED_ON_AGE_TIER dominance (#2041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a NOT_REQUIRED season row dominates a Youth stored tier (mid-season age-up stays not-unpaid)", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "YOUTH" }],
      [{ memberId: "g1", status: "NOT_REQUIRED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result).toEqual([]);
  });

  it("still flags a Youth with no NOT_REQUIRED row as unpaid (defers to the age-tier flag)", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "YOUTH" }],
      [{ memberId: "g1", status: "NOT_INVOICED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result.map((r) => r.memberId)).toEqual(["g1"]);
  });

  it("an exempt Child tier is never unpaid even without a row", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb([{ id: "g1", ageTier: "CHILD" }], []);
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result).toEqual([]);
  });

  it("REQUIRED types are byte-unchanged: a NOT_REQUIRED row does NOT dominate an Adult", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "REQUIRED" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "ADULT" }],
      [{ memberId: "g1", status: "NOT_REQUIRED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result.map((r) => r.memberId)).toEqual(["g1"]);
  });
});
