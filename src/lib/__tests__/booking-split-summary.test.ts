import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  calculateBookingPrice,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/policies/pricing";
import {
  sumDeferredGuestPortionCents,
  type DeferredGuestPortionGuest,
} from "@/lib/deferred-guest-portion";

// #2003 — the deferred non-member "guest portion" figure is shown on two
// surfaces (the wizard review banner and the pay step). These tests pin that a
// SINGLE owner computes it, and that its value equals the server figure the pay
// step shows (the split child's finalPriceCents) for the same composition —
// including a composition where naive dual-sourcing could have drifted.

const MEMBER_TYPE = "member-type";
const NON_MEMBER_TYPE = "non-member-type";

describe("sumDeferredGuestPortionCents (single owner of the figure, #2003)", () => {
  it("sums only the non-member guests' priced totals, in integer cents", () => {
    const guests: DeferredGuestPortionGuest[] = [
      { isMember: true, priceCents: 24000 },
      { isMember: false, priceCents: 12999 },
      { isMember: false, priceCents: 8331 },
    ];
    expect(sumDeferredGuestPortionCents(guests)).toBe(21330);
  });

  it("returns 0 when there are no non-member guests (no split)", () => {
    expect(
      sumDeferredGuestPortionCents([{ isMember: true, priceCents: 24000 }]),
    ).toBe(0);
  });

  it("treats a missing/undefined priceCents as 0 rather than NaN", () => {
    expect(
      sumDeferredGuestPortionCents([
        { isMember: false, priceCents: 12999 },
        { isMember: false } as unknown as DeferredGuestPortionGuest,
      ]),
    ).toBe(12999);
  });
});

describe("review-step figure equals the pay-step (server child) figure (#2003)", () => {
  // Odd per-night rates that do NOT divide evenly across the stay: a naive
  // dual-sourcing that rounded (e.g. nights * average nightly rate) would drift
  // from the true integer per-night sum. Both the review banner and the split
  // child are priced by the same engine, so summing per-night integer cents
  // through one owner is the only way they match to the cent.
  const checkIn = parseDateOnly("2026-07-20");
  const checkOut = parseDateOnly("2026-07-23"); // 3 nights: 20, 21, 22

  const seasons: SeasonRateData[] = [
    {
      seasonId: "season-1",
      startDate: parseDateOnly("2026-07-01"),
      endDate: parseDateOnly("2026-07-31"),
      rates: [
        { membershipTypeId: MEMBER_TYPE, ageTier: "ADULT", pricePerNightCents: 8000 },
        { membershipTypeId: NON_MEMBER_TYPE, ageTier: "ADULT", pricePerNightCents: 4333 },
        { membershipTypeId: NON_MEMBER_TYPE, ageTier: "CHILD", pricePerNightCents: 2777 },
      ],
    },
  ];

  const memberGuest: GuestInput = {
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: MEMBER_TYPE,
  };
  const nonMemberAdult: GuestInput = {
    ageTier: "ADULT",
    isMember: false,
    rateMembershipTypeId: NON_MEMBER_TYPE,
  };
  const nonMemberChild: GuestInput = {
    ageTier: "CHILD",
    isMember: false,
    rateMembershipTypeId: NON_MEMBER_TYPE,
  };

  it("the two independently-sourced 'about $X' figures resolve to the same cents", () => {
    // Review step: the whole party is quoted together; the banner sums the
    // non-member rows of that quote via the single owner (mirrors
    // review-step.tsx consuming priceQuote.guests).
    const fullPartyQuote = calculateBookingPrice(
      checkIn,
      checkOut,
      [memberGuest, nonMemberAdult, nonMemberChild],
      seasons,
    );
    const reviewFigure = sumDeferredGuestPortionCents(fullPartyQuote.guests);

    // Pay step: booking-create prices the non-member subset on its own and
    // stores that total as the split child's finalPriceCents, which the payment
    // route surfaces as deferredGuestAmountCents (getProvisionalNonMemberChildSummary).
    const childPrice = calculateBookingPrice(
      checkIn,
      checkOut,
      [nonMemberAdult, nonMemberChild],
      seasons,
    );
    const payStepFigure = childPrice.totalPriceCents; // == child.finalPriceCents

    // Exact, per-night integer cents — 3 * 4333 + 3 * 2777.
    expect(reviewFigure).toBe(12999 + 8331);
    expect(payStepFigure).toBe(12999 + 8331);
    // The load-bearing assertion: same composition ⇒ same figure on both surfaces.
    expect(reviewFigure).toBe(payStepFigure);
  });
});
