// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewStep } from "@/app/(authenticated)/book/_components/review-step";
import type { PriceQuote } from "@/app/(authenticated)/book/_components/types";
import type { GuestData } from "@/components/guest-form";
import { sumDeferredGuestPortionCents } from "@/lib/deferred-guest-portion";

vi.mock("@/components/time-picker", () => ({
  TimePicker: () => <div data-testid="time-picker" />,
}));
vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

const memberGuest: GuestData = {
  firstName: "Sam",
  lastName: "Skier",
  ageTier: "ADULT",
  isMember: true,
  memberId: "member-self",
};
const nonMemberGuest: GuestData = {
  firstName: "Robin",
  lastName: "Visitor",
  ageTier: "ADULT",
  isMember: false,
};

function buildQuote(
  guests: GuestData[],
  hold?: PriceQuote["nonMemberHoldDecision"],
): PriceQuote {
  return {
    guests: guests.map((g) => ({
      ageTier: g.ageTier,
      isMember: g.isMember,
      nights: 2,
      priceCents: g.isMember ? 8000 : 12000,
    })),
    totalPriceCents: guests.reduce(
      (sum, g) => sum + (g.isMember ? 8000 : 12000),
      0,
    ),
    nonMemberHoldDecision: hold,
  };
}

function renderReview(
  guests: GuestData[],
  hold?: PriceQuote["nonMemberHoldDecision"],
  overrides: Partial<ComponentProps<typeof ReviewStep>> = {},
) {
  const priceQuote = buildQuote(guests, hold);
  return render(
    <ReviewStep
      checkIn={new Date(2026, 6, 20)}
      checkOut={new Date(2026, 6, 22)}
      nights={2}
      guests={guests}
      priceQuote={priceQuote}
      lodges={[]}
      lodgeId={null}
      selectedLodge={null}
      reviewGuestPayload={guests}
      bookingDateStrings={{ checkIn: "2026-07-20", checkOut: "2026-07-22" }}
      perGuestDatesEnabled={false}
      appliedPromo={null}
      setAppliedPromo={vi.fn()}
      availableCreditCents={0}
      appliedCreditCents={0}
      remainingToPay={priceQuote.totalPriceCents}
      useCredit={false}
      setUseCredit={vi.fn()}
      groupTrip={false}
      groupBookingsEnabled={false}
      groupPaymentMode="EACH_PAYS_OWN"
      showPaymentMethodChoice={false}
      paymentMethod="stripe"
      setPaymentMethod={vi.fn()}
      internetBankingEnabled={false}
      internetBankingUnavailableReason={null}
      internetBankingHoldSummary={null}
      cardPaymentDescription=""
      internetBankingPaymentDescription=""
      internetBankingUnavailableCopy=""
      notes=""
      setNotes={vi.fn()}
      requiresAdminReviewLocal={false}
      memberReviewJustification=""
      setMemberReviewJustification={vi.fn()}
      expectedArrivalTime={null}
      setExpectedArrivalTime={vi.fn()}
      roomRequestEnabled={false}
      roomOptions={[]}
      requestedRoomId={null}
      setRequestedRoomId={vi.fn()}
      activeWorkPartyEvents={[]}
      attendingWorkParty={false}
      setAttendingWorkParty={vi.fn()}
      selectedWorkPartyEventId={null}
      setSelectedWorkPartyEventId={vi.fn()}
      workPartyError=""
      setWorkPartyError={vi.fn()}
      workPartyClearedNotice={null}
      setWorkPartyClearedNotice={vi.fn()}
      availablePromoCodes={[]}
      promoCodesEnabled={false}
      prefillPromoCode={undefined}
      setPrefillPromoCode={vi.fn()}
      cancelIfGuestsBumped={false}
      setCancelIfGuestsBumped={vi.fn()}
      setStep={vi.fn()}
      handleSaveAsDraft={vi.fn()}
      handleSubmit={vi.fn()}
      submitting={false}
      savingDraft={false}
      {...overrides}
    />,
  );
}

const splitHold: PriceQuote["nonMemberHoldDecision"] = {
  enabled: true,
  holdDays: 7,
  source: "default",
  daysUntilCheckIn: 30,
  shouldBePending: true,
  status: "PAYMENT_PENDING",
};

describe("ReviewStep split provisional copy (#1942)", () => {
  it("explains the split when the party mixes member and non-member guests outside the hold window", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold);

    expect(
      screen.getByText(/non-member guests are held provisionally/i),
    ).toBeInTheDocument();
    // Names the provisional guest (the <strong> holds exactly the name, while
    // the guest row renders "Robin Visitor (ADULT, Non-member)").
    expect(screen.getByText("Robin Visitor")).toBeInTheDocument();
    expect(screen.getByText(/Held provisionally:/i)).toBeInTheDocument();
    // States today's charge covers only the member portion.
    expect(
      screen.getByText(/Today you only pay for the member places/i),
    ).toBeInTheDocument();
    // Shows the guest-portion sub-amount derived from the quote ($120.00) and
    // frames it as the non-member-rate portion not charged today — without
    // anchoring on "the total above" (which is the net remainingToPay). FIX 3.
    expect(
      screen.getByText(/at non-member rates\) are not charged today/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/\$120\.00/).length).toBeGreaterThanOrEqual(1);
    // Honest later-charge wording: saved payment method, not "the same card",
    // with a fallback promise if we cannot take payment. FIX 2.
    expect(
      screen.getByText(/take the non-member portion from your saved payment method/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contact you to arrange it/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/the same card/i),
    ).not.toBeInTheDocument();
    // Explains the "why" using the hold-days from the quote.
    expect(screen.getByText(/more than 7 days away/i)).toBeInTheDocument();
  });

  it("renders the deferred guest portion from the single owner, not an ad-hoc sum (#2003)", () => {
    // A composition with odd, non-round per-guest cents (two non-members) so
    // the banner's figure is the exact integer sum the shared owner produces —
    // the same figure the pay step shows for this composition.
    const secondNonMember: GuestData = {
      firstName: "Alex",
      lastName: "Guest",
      ageTier: "CHILD",
      isMember: false,
    };
    const guests = [memberGuest, nonMemberGuest, secondNonMember];
    const priceQuote: PriceQuote = {
      guests: [
        { ageTier: "ADULT", isMember: true, nights: 3, priceCents: 24000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 12999 },
        { ageTier: "CHILD", isMember: false, nights: 3, priceCents: 8331 },
      ],
      totalPriceCents: 24000 + 12999 + 8331,
      nonMemberHoldDecision: splitHold,
    };
    const expectedCents = sumDeferredGuestPortionCents(priceQuote.guests);
    expect(expectedCents).toBe(12999 + 8331); // 21330 → $213.30

    renderReview(guests, splitHold, {
      priceQuote,
      reviewGuestPayload: guests,
      remainingToPay: priceQuote.totalPriceCents,
    });

    // The banner renders the owner's figure ($213.30), not the party total.
    expect(screen.getAllByText(/\$213\.30/).length).toBeGreaterThanOrEqual(1);
  });

  it("prefers the server deferredGuestPortionCents over the whole-party sum, so a group discount cannot under-quote the banner (#2003)", () => {
    // Under a group discount the whole-party quote's non-member rows are
    // discounted ($90.00 each → $180.00), but the split child is charged the
    // non-member subset alone, which is NOT discounted ($259.98). The server
    // sends deferredGuestPortionCents = the subset figure; the banner must show
    // THAT (what is actually charged), never the lower whole-party sum.
    const secondNonMember: GuestData = {
      firstName: "Alex",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
    };
    const guests = [memberGuest, nonMemberGuest, secondNonMember];
    const priceQuote: PriceQuote = {
      guests: [
        { ageTier: "ADULT", isMember: true, nights: 3, priceCents: 9000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 9000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 9000 },
      ],
      totalPriceCents: 27000,
      // The server-priced non-member subset (undiscounted): the real charge.
      deferredGuestPortionCents: 25998,
      nonMemberHoldDecision: splitHold,
    };
    // The naive whole-party sum would have shown the discounted $180.00.
    expect(sumDeferredGuestPortionCents(priceQuote.guests)).toBe(18000);

    renderReview(guests, splitHold, {
      priceQuote,
      reviewGuestPayload: guests,
      remainingToPay: priceQuote.totalPriceCents,
    });

    // The banner shows the server figure ($259.98), NOT the discounted sum.
    expect(screen.getAllByText(/\$259\.98/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/\$180\.00/)).not.toBeInTheDocument();
  });

  it("shows no provisional copy for an all-member party (no split)", () => {
    renderReview([memberGuest], undefined);

    expect(
      screen.queryByText(/held provisionally/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
  });

  it("shows no provisional copy inside the hold window (shouldBePending false)", () => {
    renderReview([memberGuest, nonMemberGuest], {
      ...splitHold,
      daysUntilCheckIn: 3,
      shouldBePending: false,
    });

    expect(
      screen.queryByText(/held provisionally/i),
    ).not.toBeInTheDocument();
  });

  it("uses the single-hold copy (not split copy) for an all-non-member provisional party", () => {
    renderReview([nonMemberGuest], splitHold);

    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
    // Not the split-specific member-portion wording.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
  });

  it("shows no split banner when 'Only book if my guests can come' is ticked (server keeps the whole party as one provisional booking) — FIX 1", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      cancelIfGuestsBumped: true,
    });

    // The split banner's up-front-charge claims would be false on the flagged
    // path (one PENDING booking, nothing charged now), so it must not show.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
    // The adjacent checkbox copy (nothing charged up front) stays coherent: the
    // whole-party single-hold notice is shown instead.
    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only book if my guests can come/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing is charged up front/i),
    ).toBeInTheDocument();
  });

  it("keeps the guest-portion copy coherent when a promo drops the net total below the gross guest portion — FIX 3", () => {
    // Net remainingToPay ($60) is now BELOW the gross non-member portion
    // ($120), so the old "$X of the total above" phrasing would have implied
    // more than the whole total. The rephrased copy anchors on non-member
    // rates instead of "the total above", staying self-consistent.
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      appliedPromo: {
        code: "SAVE",
        description: null,
        type: "PERCENT",
        discountCents: 14000,
        promoAdjustmentCents: -14000,
        totalPriceCents: 20000,
        finalPriceCents: 6000,
      },
      remainingToPay: 6000,
    });

    expect(
      screen.getByText(/at non-member rates\) are not charged today/i),
    ).toBeInTheDocument();
    // The gross guest portion is still shown ($120.00) but no longer framed as
    // a slice of "the total above".
    expect(
      screen.queryByText(/of the total above is for your non-member guests/i),
    ).not.toBeInTheDocument();
  });

  it("shows no split banner when the booking is held for admin review — FIX 1", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      requiresAdminReviewLocal: true,
      memberReviewJustification: "No adult can attend.",
    });

    // Admin-review bookings are never split — the whole party waits in review.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
    // The whole-party-hold fallback copy is shown instead of the split banner.
    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
  });
});
