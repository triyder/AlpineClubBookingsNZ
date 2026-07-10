// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
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

const room: DashboardRoom = {
  id: "room-1",
  name: "Room One",
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
    },
  ],
};

describe("RoomTable active drag lane rendering", () => {
  it("renders the active date lane tint while preserving fixed board widths", () => {
    const nights = ["2026-07-01", "2026-07-02"];
    const { container } = render(
      <RoomTable
        room={room}
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
