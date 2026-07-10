// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuestsStep } from "@/app/(authenticated)/book/_components/guests-step";
import type { FamilyMember } from "@/app/(authenticated)/book/_components/types";
import type { GuestData } from "@/components/guest-form";

vi.mock("@/components/guest-form", () => ({
  GuestForm: () => <div data-testid="guest-form" />,
}));

function renderGuestsStep(
  overrides: Partial<ComponentProps<typeof GuestsStep>> = {},
) {
  return render(
    <GuestsStep
      checkIn={new Date(2026, 6, 10)}
      checkOut={new Date(2026, 6, 12)}
      nights={2}
      familyMembers={[]}
      guests={[]}
      lodgeCapacity={8}
      addFamilyMemberAsGuest={vi.fn()}
      showInviteFamilyGroupMembersLink={false}
      handleGuestsChange={vi.fn()}
      perGuestDatesEnabled={false}
      handlePerGuestDatesEnabledChange={vi.fn()}
      multiDateRangesEnabled={false}
      handleMultiDateRangesEnabledChange={vi.fn()}
      priceQuote={null}
      groupBookingsEnabled={false}
      groupTrip={false}
      setGroupTrip={vi.fn()}
      groupPaymentMode="EACH_PAYS_OWN"
      setGroupPaymentMode={vi.fn()}
      setStep={vi.fn()}
      handleGuestsDone={vi.fn()}
      priceLoading={false}
      {...overrides}
    />,
  );
}

describe("GuestsStep", () => {
  it("keeps the family-profile pointer visible when some family members already exist", () => {
    const familyMembers: FamilyMember[] = [
      {
        id: "member-self",
        firstName: "Sam",
        lastName: "Skier",
        ageTier: "ADULT",
        relationship: "self",
      },
      {
        id: "member-child",
        firstName: "Casey",
        lastName: "Skier",
        ageTier: "CHILD",
        relationship: "dependent",
      },
    ];

    render(
      <GuestsStep
        checkIn={new Date(2026, 6, 10)}
        checkOut={new Date(2026, 6, 12)}
        nights={2}
        familyMembers={familyMembers}
        guests={[]}
        lodgeCapacity={8}
        addFamilyMemberAsGuest={vi.fn()}
        showInviteFamilyGroupMembersLink={false}
        handleGuestsChange={vi.fn()}
        perGuestDatesEnabled={false}
        handlePerGuestDatesEnabledChange={vi.fn()}
        multiDateRangesEnabled={false}
        handleMultiDateRangesEnabledChange={vi.fn()}
        priceQuote={null}
        groupBookingsEnabled={false}
        groupTrip={false}
        setGroupTrip={vi.fn()}
        groupPaymentMode="EACH_PAYS_OWN"
        setGroupPaymentMode={vi.fn()}
        setStep={vi.fn()}
        handleGuestsDone={vi.fn()}
        priceLoading={false}
      />,
    );

    expect(screen.getByText(/Family member missing/i)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open Family Group in your profile" })
        .getAttribute("href"),
    ).toBe("/profile?returnTo=%2Fbook#family-group");
  });

  it("shows the booker's quick-add in its added (✓) state when self is pre-selected", () => {
    const self: FamilyMember = {
      id: "member-self",
      firstName: "Sam",
      lastName: "Skier",
      ageTier: "ADULT",
      relationship: "self",
      canBeBooked: true,
    };
    const child: FamilyMember = {
      id: "member-child",
      firstName: "Casey",
      lastName: "Skier",
      ageTier: "CHILD",
      relationship: "dependent",
      canBeBooked: true,
    };
    const seededSelf: GuestData = {
      firstName: "Sam",
      lastName: "Skier",
      ageTier: "ADULT",
      isMember: true,
      memberId: "member-self",
    };

    renderGuestsStep({ familyMembers: [self, child], guests: [seededSelf] });

    // The pre-selected booker renders the ✓ added-state button, disabled so it
    // cannot be added twice.
    const selfButton = screen.getByRole("button", { name: "✓ Sam Skier (You)" });
    expect(selfButton).toBeDisabled();

    // A family member not yet in the party still shows the add (+) affordance.
    const childButton = screen.getByRole("button", {
      name: "+ Casey Skier (CHILD)",
    });
    expect(childButton).toBeEnabled();
  });
});
