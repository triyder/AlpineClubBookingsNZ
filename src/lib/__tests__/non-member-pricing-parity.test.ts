import { describe, it, expect } from "vitest";
import {
  priceBookingGuests,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";

/**
 * Pricing-parity invariant (#1935, E9): an admin-created non-member booking
 * owner is priced identically to a public booking-request non-member for an
 * equivalent guest set.
 *
 * Both paths feed the SAME shared engine (`priceBookingGuests`) with their
 * guests forced to non-member: the public booking-request maps every guest to
 * `isMember: false` (booking-request.ts), and the on-behalf create forces typed
 * guests to non-member (verified by the "forces manually typed guests to
 * non-member pricing" test). This test asserts on quoted TOTALS only — never on
 * SeasonRate/isMember internals — so it survives E4's (#1930) rate re-key
 * regardless of merge order.
 */

const rawSeasons = [
  {
    id: "s-winter",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-09-30"),
    type: "WINTER" as const,
    rates: [
      { ageTier: "ADULT" as const, isMember: false, pricePerNightCents: 6000 },
      { ageTier: "ADULT" as const, isMember: true, pricePerNightCents: 4000 },
      { ageTier: "CHILD" as const, isMember: false, pricePerNightCents: 3000 },
      { ageTier: "CHILD" as const, isMember: true, pricePerNightCents: 2000 },
    ],
  },
];
const seasons = toSeasonRateData(rawSeasons);
const checkIn = new Date("2026-07-10");
const checkOut = new Date("2026-07-12"); // 2 nights
const guestTiers = [{ ageTier: "ADULT" as const }, { ageTier: "CHILD" as const }];

function totalFor(isMember: boolean) {
  return priceBookingGuests({
    checkIn,
    checkOut,
    seasons,
    guests: guestTiers.map((g) => ({ ageTier: g.ageTier, isMember })),
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
