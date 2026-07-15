// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const allFeaturesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

type CardProps = Partial<ComponentProps<typeof AdminBookingToolsCard>>;

function renderCard(features: FeatureFlags, overrides: CardProps = {}) {
  return render(
    <AdminBookingToolsCard
      bookingId="booking-1"
      memberId="member-1"
      memberName="Aroha Ngata"
      checkIn={new Date("2026-07-01T00:00:00.000Z")}
      checkOut={new Date("2026-07-03T00:00:00.000Z")}
      copyProps={{
        sourceCheckIn: "2026-07-01",
        sourceCheckOut: "2026-07-03",
        minCheckIn: "2026-06-01",
      }}
      isDeleted={false}
      paymentId={null}
      showConfirmPendingGuests={false}
      hasSavedPaymentMethod={false}
      finalPriceCents={10000}
      features={features}
      {...overrides}
    />,
  );
}

/** Exclusive-hold state (#121, #173) with sensible non-held defaults. */
function exclusiveHold(
  overrides: Partial<
    NonNullable<ComponentProps<typeof AdminBookingToolsCard>["exclusiveHold"]>
  > = {},
) {
  return {
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    heldByName: null,
    holdsCapacity: true,
    conflicts: [],
    ...overrides,
  };
}

describe("AdminBookingToolsCard", () => {
  it("shows the bed allocation link when the module is enabled", () => {
    renderCard(allFeaturesOn);

    const link = screen.getByRole("link", { name: "Bed allocation" });

    expect(link.getAttribute("href")).toContain("/admin/bed-allocation?");
    expect(link.getAttribute("href")).toContain("bookingId=booking-1");
    expect(link.getAttribute("href")).toContain("from=2026-07-01");
    expect(link.getAttribute("href")).toContain("to=2026-07-03");
  });

  it("hides the bed allocation link when the module is disabled", () => {
    renderCard({ ...allFeaturesOn, bedAllocation: false });

    expect(
      screen.queryByRole("link", { name: "Bed allocation" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Member: Aroha Ngata" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Xero activity" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Audit log" })).toBeTruthy();
  });

  // Exclusive whole-lodge hold Set gating (issue #173, H2): the Set control is
  // only offered on capacity-holding bookings — a hold on a non-holding booking
  // blocks nothing (ADR-001 capacity rule) — while clearing an existing hold is
  // always allowed.
  describe("exclusive hold Set gating", () => {
    it("enables Set for a capacity-holding booking with no hold", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({ holdsCapacity: true }),
      });

      const setButton = screen.getByRole("button", {
        name: "Set exclusive hold",
      });
      expect(setButton).toBeTruthy();
      expect((setButton as HTMLButtonElement).disabled).toBe(false);
      expect(
        screen.queryByText(/does not hold lodge capacity/i),
      ).toBeNull();
    });

    it("disables Set with an explanatory hint for a non-capacity-holding booking", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({ holdsCapacity: false }),
      });

      const setButton = screen.getByRole("button", {
        name: "Set exclusive hold",
      });
      expect((setButton as HTMLButtonElement).disabled).toBe(true);
      expect(
        screen.getByText(/does not hold lodge capacity/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/apply an admin capacity hold first/i),
      ).toBeTruthy();
    });

    it("keeps Clear enabled even when the booking is not capacity-holding", () => {
      renderCard(allFeaturesOn, {
        exclusiveHold: exclusiveHold({
          wholeLodgeHold: true,
          holdsCapacity: false,
        }),
      });

      const clearButton = screen.getByRole("button", {
        name: "Clear exclusive hold",
      });
      expect((clearButton as HTMLButtonElement).disabled).toBe(false);
      // No Set control is rendered while a hold is in place.
      expect(
        screen.queryByRole("button", { name: "Set exclusive hold" }),
      ).toBeNull();
    });
  });
});
