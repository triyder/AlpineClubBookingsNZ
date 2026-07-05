// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AllocationChip } from "@/app/(admin)/admin/bed-allocation/_components/allocation-chip";
import type { DashboardAllocation } from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
  }),
}));

function buildAllocation(
  overrides: Partial<DashboardAllocation> = {},
): DashboardAllocation {
  return {
    id: "allocation-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Example Guest",
    guestAgeTier: "ADULT",
    roomId: "room-1",
    roomName: "Room One",
    bedId: "bed-1",
    bedName: "Bed One",
    stayDate: "2026-07-01",
    source: "MANUAL",
    approvedAt: null,
    approvedByName: null,
    bookingStatus: "CONFIRMED",
    holdsCapacity: true,
    ...overrides,
  };
}

function renderChip(allocation: DashboardAllocation, canEdit = true) {
  return render(
    <AllocationChip
      allocation={allocation}
      bedOptions={[]}
      onReassignBed={vi.fn()}
      onRemove={vi.fn()}
      pending={false}
      canEdit={canEdit}
    />,
  );
}

describe("AllocationChip held vs provisional state (#1251)", () => {
  it("labels a capacity-holding booking as Held with a solid border", () => {
    const { container } = renderChip(
      buildAllocation({ bookingStatus: "PAID", holdsCapacity: true }),
    );

    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.queryByText("Provisional")).toBeNull();

    // The chip card must not use the dashed treatment reserved for provisional
    // beds — Held reads as a firm hold at a glance.
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).not.toContain("border-dashed");
  });

  it("labels a provisional booking as Provisional with a dashed border", () => {
    const { container } = renderChip(
      buildAllocation({ bookingStatus: "PENDING", holdsCapacity: false }),
    );

    expect(screen.getByText("Provisional")).toBeTruthy();
    expect(screen.queryByText("Held")).toBeNull();

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-dashed");
  });

  it("labels an accepted-but-unpaid quote (PENDING but holding) as Held (#1254)", () => {
    // Server sets holdsCapacity=true for a request-converted PENDING booking, so
    // the board must show it Held even though its status is PENDING.
    renderChip(buildAllocation({ bookingStatus: "PENDING", holdsCapacity: true }));

    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.queryByText("Provisional")).toBeNull();
  });

  it.each(["PAYMENT_PENDING", "WAITLIST_OFFERED"])(
    "treats %s (bed-allocatable but not capacity-holding) as Provisional",
    (status) => {
      renderChip(buildAllocation({ bookingStatus: status, holdsCapacity: false }));
      expect(screen.getByText("Provisional")).toBeTruthy();
    },
  );

  it("uses theme tokens (not hardcoded light colours) for both states", () => {
    const { container: held } = renderChip(
      buildAllocation({ bookingStatus: "CONFIRMED", holdsCapacity: true }),
    );
    const { container: provisional } = renderChip(
      buildAllocation({ bookingStatus: "PENDING", holdsCapacity: false }),
    );

    // Regression guard for the dark-mode requirement: the previous chip used
    // `bg-white`, which breaks in dark mode. The distinction now rides on
    // theme-aware tokens plus a non-colour signal (border style + label).
    const heldCard = held.firstElementChild as HTMLElement;
    const provisionalCard = provisional.firstElementChild as HTMLElement;
    expect(heldCard.className).not.toContain("bg-white");
    expect(provisionalCard.className).not.toContain("bg-white");
    expect(heldCard.className).toContain("bg-card");
    expect(provisionalCard.className).toContain("bg-muted");
  });

  it("disables drag and manage controls for view-only booking access", () => {
    renderChip(buildAllocation(), false);

    expect(
      screen.getByRole("button", { name: /Drag Example Guest to another bed or night/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Manage allocation for Example Guest/i }),
    ).toBeDisabled();
  });
});
