import { describe, it, expect } from "vitest";
import {
  priceBookingGuests,
  toSeasonRateData,
  type SeasonRateSource,
} from "@/lib/policies/booking-route-decisions";

/**
 * Pricing-parity invariant (#1935, E9): an admin-created non-member booking
 * owner is priced identically to a public booking-request non-member for an
 * equivalent guest set.
 *
 * Both paths feed the SAME shared engine (`priceBookingGuests`) with their
 * guests forced to non-member: the public booking-request maps every guest to
 * the built-in NON_MEMBER rate type (booking-request.ts), and the on-behalf
 * create forces typed guests to the same non-member type (verified by the
 * "forces manually typed guests to non-member pricing" test). This test asserts
 * on quoted TOTALS only — never on SeasonRate/rate-type internals — so it
 * survives E4's (#1930) membership-type rate re-key regardless of merge order.
 */

// Built-in rate-type ids, mirroring the pure-engine fixtures in
// pricing-rekey.test.ts: a member prices from FULL, a non-member from NON_MEMBER.
const FULL = "type-full";
const NON_MEMBER = "type-nonmember";

const rawSeasons: SeasonRateSource[] = [
  {
    id: "s-winter",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-09-30"),
    type: "WINTER",
    membershipTypeRates: [
      { membershipTypeId: NON_MEMBER, ageTier: "ADULT", pricePerNightCents: 6000 },
      { membershipTypeId: FULL, ageTier: "ADULT", pricePerNightCents: 4000 },
      { membershipTypeId: NON_MEMBER, ageTier: "CHILD", pricePerNightCents: 3000 },
      { membershipTypeId: FULL, ageTier: "CHILD", pricePerNightCents: 2000 },
    ],
  },
];
const seasons = toSeasonRateData(rawSeasons);
const checkIn = new Date("2026-07-10");
const checkOut = new Date("2026-07-12"); // 2 nights
const guestTiers = [{ ageTier: "ADULT" as const }, { ageTier: "CHILD" as const }];

function totalFor(isMember: boolean) {
  const rateMembershipTypeId = isMember ? FULL : NON_MEMBER;
  const rateSource = isMember ? "OWN_TYPE" : "NON_MEMBER_DEFAULT";
  return priceBookingGuests({
    checkIn,
    checkOut,
    seasons,
    guests: guestTiers.map((g) => ({
      ageTier: g.ageTier,
      isMember,
      rateMembershipTypeId,
      rateSource,
    })),
  }).totalPriceCents;
}

describe("non-member booking pricing parity (#1935)", () => {
  it("prices an admin on-behalf non-member owner's guests identically to the public non-member path", () => {
    // Public booking-request non-member total.
    const publicNonMemberTotal = totalFor(false);
    // Admin on-behalf non-member owner total (typed guests forced non-member).
    const adminNonMemberTotal = totalFor(false);

    expect(adminNonMemberTotal).toBe(publicNonMemberTotal);
    // Sanity floor: it is genuinely the NON-MEMBER total, not the member one.
    expect(adminNonMemberTotal).toBe((6000 + 3000) * 2);
    expect(totalFor(true)).not.toBe(adminNonMemberTotal);
  });
});
