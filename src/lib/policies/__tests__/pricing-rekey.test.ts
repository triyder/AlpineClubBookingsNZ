import { describe, it, expect } from "vitest";
import {
  calculateBookingPrice,
  findRateForNight,
  type GroupDiscountConfig,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/pricing";

// Membership-type re-key acceptance matrix (#1930, E4). These are pure-engine
// tests: the resolver's job (classifying guests + assigning rateMembershipTypeId
// / rateSource) is exercised in membership-type-policy.test.ts; here we pin the
// pricing behaviour those inputs must produce.

const FULL = "type-full";
const CLUB = "type-club"; // a non-FULL MEMBER_RATE type with its OWN, distinct rate
const NON_MEMBER = "type-nonmember";
const FLAT = "type-flat"; // a flat (ageGroupsApply=false) type: one NULL-ageTier row

const checkIn = new Date("2026-07-10");
const checkOut = new Date("2026-07-13"); // 3 nights

const seasons: SeasonRateData[] = [
  {
    seasonId: "s-winter",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-09-30"),
    type: "WINTER",
    rates: [
      // Fan-out day one copies the member price to every MEMBER_RATE type, so
      // FULL and CLUB share 1000 in the byte-identical test; the matrix tests
      // give CLUB a distinct price to prove OWN_TYPE keeps its own rate.
      { membershipTypeId: FULL, ageTier: "ADULT", pricePerNightCents: 1000 },
      { membershipTypeId: FULL, ageTier: "CHILD", pricePerNightCents: 500 },
      { membershipTypeId: CLUB, ageTier: "ADULT", pricePerNightCents: 800 },
      { membershipTypeId: CLUB, ageTier: "CHILD", pricePerNightCents: 400 },
      { membershipTypeId: NON_MEMBER, ageTier: "ADULT", pricePerNightCents: 2400 },
      { membershipTypeId: NON_MEMBER, ageTier: "CHILD", pricePerNightCents: 1200 },
      // Flat type: single NULL-ageTier row applies to every tier.
      { membershipTypeId: FLAT, ageTier: null, pricePerNightCents: 700 },
    ],
  },
];

function guest(overrides: Partial<GuestInput> & Pick<GuestInput, "rateMembershipTypeId">): GuestInput {
  return {
    ageTier: "ADULT",
    isMember: true,
    ...overrides,
  };
}

describe("hut rate re-key: byte-identical fan-out (#1930, E4)", () => {
  it("a member prices from its own MEMBER_RATE type; a non-member from NON_MEMBER", () => {
    const price = calculateBookingPrice(checkIn, checkOut, [
      guest({ rateMembershipTypeId: FULL, isMember: true, rateSource: "OWN_TYPE" }),
      guest({ rateMembershipTypeId: NON_MEMBER, isMember: false, rateSource: "NON_MEMBER_DEFAULT" }),
    ], seasons);
    // 3 nights each: member 3×1000, non-member 3×2400.
    expect(price.guests[0].priceCents).toBe(3000);
    expect(price.guests[1].priceCents).toBe(7200);
    // The resolved snapshot is carried through for persistence.
    expect(price.guests[0].rateMembershipTypeId).toBe(FULL);
    expect(price.guests[1].rateMembershipTypeId).toBe(NON_MEMBER);
  });

  it("findRateForNight keys on the membership type + tier with a flat fallback", () => {
    const night = new Date("2026-07-10");
    expect(findRateForNight(night, "ADULT", FULL, seasons)).toBe(1000);
    expect(findRateForNight(night, "CHILD", NON_MEMBER, seasons)).toBe(1200);
    // Flat type: any tier resolves to the single NULL-ageTier row.
    expect(findRateForNight(night, "ADULT", FLAT, seasons)).toBe(700);
    expect(findRateForNight(night, "CHILD", FLAT, seasons)).toBe(700);
  });
});

describe("hut rate re-key: group-discount rateSource matrix (#1930, E4)", () => {
  const groupDiscount: GroupDiscountConfig = {
    enabled: true,
    minGroupSize: 3,
    summerOnly: false,
    rateMembershipTypeId: FULL, // substitution target for true non-members
  };

  it("substitutes only NON_MEMBER_DEFAULT guests; members keep own rate, TYPE_POLICY_FORCED excluded", () => {
    const price = calculateBookingPrice(
      checkIn,
      checkOut,
      [
        // OWN_TYPE full member: own rate 1000, unaffected by the discount.
        guest({ rateMembershipTypeId: FULL, isMember: true, rateSource: "OWN_TYPE" }),
        // OWN_TYPE non-FULL member: keeps ITS OWN 800 rate (NOT substituted to FULL's 1000).
        guest({ rateMembershipTypeId: CLUB, isMember: true, rateSource: "OWN_TYPE" }),
        // NON_MEMBER_DEFAULT: substituted to FULL -> priced at 1000, not 2400.
        guest({ rateMembershipTypeId: NON_MEMBER, isMember: false, rateSource: "NON_MEMBER_DEFAULT" }),
        // TYPE_POLICY_FORCED member: excluded from the discount -> stays 2400.
        guest({ rateMembershipTypeId: NON_MEMBER, isMember: true, rateSource: "TYPE_POLICY_FORCED" }),
      ],
      seasons,
      groupDiscount,
    );

    expect(price.guests[0].priceCents).toBe(3000); // 3×1000 own full
    expect(price.guests[1].priceCents).toBe(2400); // 3×800 own club, NOT substituted
    expect(price.guests[2].priceCents).toBe(3000); // 3×1000 substituted to full
    expect(price.guests[3].priceCents).toBe(7200); // 3×2400 forced non-member, no discount

    // Snapshots persist the RESOLVED type, never the per-night substitution:
    // the substituted non-member's snapshot stays NON_MEMBER.
    expect(price.guests[2].rateMembershipTypeId).toBe(NON_MEMBER);
  });

  it("does not substitute when the party is below the minimum group size", () => {
    const price = calculateBookingPrice(
      checkIn,
      checkOut,
      [guest({ rateMembershipTypeId: NON_MEMBER, isMember: false, rateSource: "NON_MEMBER_DEFAULT" })],
      seasons,
      groupDiscount,
    );
    expect(price.guests[0].priceCents).toBe(7200); // 3×2400, no discount
  });
});

describe("hut rate re-key: missing rate hard-throws (#1930, E4)", () => {
  it("throws when the resolved membership type has no rate row for the night", () => {
    expect(() =>
      calculateBookingPrice(
        checkIn,
        checkOut,
        [guest({ rateMembershipTypeId: "type-unconfigured", isMember: true, rateSource: "OWN_TYPE" })],
        seasons,
      ),
    ).toThrow(/No rate found/);
  });
});
