// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewStep } from "@/app/(authenticated)/book/_components/review-step";
import type { PriceQuote } from "@/app/(authenticated)/book/_components/types";
import type { GuestData } from "@/components/guest-form";

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
    // frames it as the portion not charged today.
    expect(
      screen.getByText(/of the total above is for your non-member guests/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/\$120\.00/).length).toBeGreaterThanOrEqual(1);
    // Explains the "why" using the hold-days from the quote.
    expect(screen.getByText(/more than 7 days away/i)).toBeInTheDocument();
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
});
