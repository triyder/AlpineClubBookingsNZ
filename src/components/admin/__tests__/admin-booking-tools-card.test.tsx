// @vitest-environment jsdom

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

function renderCard(features: FeatureFlags) {
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
    />,
  );
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
});
