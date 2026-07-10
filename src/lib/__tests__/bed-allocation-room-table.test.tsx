// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomTable } from "@/app/(admin)/admin/bed-allocation/_components/room-table";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
} from "@/app/(admin)/admin/bed-allocation/_components/board-cell";
import type {
  DashboardAllocation,
  DashboardRoom,
} from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

// Stub the draggable AllocationChip so the RoomTable/BoardCell test focuses on
// cell layout (how many occupants render, the #1701 partner marker) without
// dnd-kit draggable / dropdown-menu internals.
vi.mock(
  "@/app/(admin)/admin/bed-allocation/_components/allocation-chip",
  () => ({
    AllocationChip: ({ allocation }: { allocation: DashboardAllocation }) => (
      <div data-testid="allocation-chip">{allocation.guestName}</div>
    ),
  }),
);

function buildRoom(): DashboardRoom {
  return {
    id: "room-1",
    name: "Example Room",
    sortOrder: 1,
    active: true,
    notes: null,
    beds: [
      {
        id: "bed-1",
        roomId: "room-1",
        name: "Bed One",
        sortOrder: 1,
        active: true,
        bedType: "SINGLE",
        bunkGroup: null,
      },
    ],
  };
}

describe("RoomTable active drag lane rendering", () => {
  it("renders the active date lane tint while preserving fixed board widths", () => {
    const nights = ["2026-07-01", "2026-07-02"];
    const { container } = render(
      <RoomTable
        room={buildRoom()}
        nights={nights}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
        activeDragDates={new Set(["2026-07-02"])}
      />,
    );

    const table = container.querySelector("table");
    expect(table).toHaveStyle({
      width: `${(nights.length + 1) * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
    });

    const cols = container.querySelectorAll("col");
    expect(cols).toHaveLength(nights.length + 1);
    const columnWidthClasses = BED_ALLOCATION_COLUMN_WIDTH_CLASS.split(" ");
    for (const col of cols) {
      expect(col).toHaveClass(...columnWidthClasses);
    }

    const inactiveCell = container.querySelector(
      'td[data-stay-date="2026-07-01"]',
    );
    const activeCell = container.querySelector(
      'td[data-stay-date="2026-07-02"]',
    );

    expect(inactiveCell).not.toHaveAttribute("data-active-drag-lane");
    expect(activeCell).toHaveAttribute("data-active-drag-lane", "true");
    expect(activeCell).toHaveClass("bg-accent/40");
    expect(activeCell).toHaveClass(...columnWidthClasses);

    const fixedCells = Array.from(container.querySelectorAll("th, td")).filter(
      (cell) => columnWidthClasses.every((className) => cell.classList.contains(className)),
    );
    expect(fixedCells).toHaveLength(nights.length * 2 + 2);
  });
});

describe("RoomTable bed-type icon (#1675)", () => {
  function renderRoom(room: DashboardRoom) {
    return render(
      <RoomTable
        room={room}
        nights={["2026-07-01"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );
  }

  it("shows an accessible bed-type label alongside the bed name (never icon-only)", () => {
    renderRoom(buildRoom());
    // The single bed's icon carries a screen-reader label + tooltip.
    expect(screen.getByText("Single bed")).toBeTruthy();
    expect(screen.getByText("Bed One")).toBeTruthy();
  });

  it("labels a paired bunk with its group and top/bottom position", () => {
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
        {
          id: "bed-bottom",
          roomId: "room-1",
          name: "Bottom",
          sortOrder: 2,
          active: true,
          bedType: "BUNK_BOTTOM",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.getByText("Bunk A · top")).toBeTruthy();
    expect(screen.getByText("Bunk A · bottom")).toBeTruthy();
  });

  it("does not imply a partner for a half-pair whose group holds only one bed", () => {
    // A surviving bunk-top whose bottom was deleted must not read as "Bunk A ·
    // top" (that implies a partner). It falls back to the plain type label.
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.queryByText("Bunk A · top")).toBeNull();
    expect(screen.getByText("Bunk (top)")).toBeTruthy();
  });
});

describe("RoomTable double-bed sharing (#1701)", () => {
  function allocation(
    overrides: Partial<DashboardAllocation> & Pick<DashboardAllocation, "id" | "guestName">,
  ): DashboardAllocation {
    return {
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      guestAgeTier: "ADULT",
      roomId: "room-1",
      roomName: "Example Room",
      bedId: "bed-dbl",
      bedName: "Double One",
      stayDate: "2026-07-01",
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      isSecondOccupant: false,
      ...overrides,
    };
  }

  it("renders both occupants of a shared double and marks the partner", () => {
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-dbl",
          roomId: "room-1",
          name: "Double One",
          sortOrder: 1,
          active: true,
          bedType: "DOUBLE",
          bunkGroup: null,
        },
      ],
    };
    const map = new Map<string, DashboardAllocation[]>([
      [
        "bed-dbl:2026-07-01",
        [
          allocation({ id: "a-primary", guestName: "Primary Guest" }),
          allocation({
            id: "a-second",
            bookingGuestId: "guest-2",
            guestName: "Second Guest",
            isSecondOccupant: true,
          }),
        ],
      ],
    ]);

    render(
      <RoomTable
        room={room}
        nights={["2026-07-01"]}
        allocationByBedAndDate={map}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );

    // Both occupants are visible (the old single-value map hid the partner).
    expect(screen.getByText("Primary Guest")).toBeTruthy();
    expect(screen.getByText("Second Guest")).toBeTruthy();
    // The second occupant is marked as a shared-bed partner.
    expect(screen.getByText("Shares bed · partner")).toBeTruthy();
  });
});
