// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomTable } from "@/app/(admin)/admin/bed-allocation/_components/room-table";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
} from "@/app/(admin)/admin/bed-allocation/_components/board-cell";
import type { DashboardRoom } from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

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
