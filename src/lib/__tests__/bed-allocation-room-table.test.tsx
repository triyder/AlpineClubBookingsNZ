// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
} from "@/app/(admin)/admin/bed-allocation/_components/board-cell";
import { RoomTable } from "@/app/(admin)/admin/bed-allocation/_components/room-table";
import type {
  DashboardRoom,
} from "@/app/(admin)/admin/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
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
      },
    ],
  };
}

describe("RoomTable layout", () => {
  it("uses the same fixed width for the bed column and every date cell", () => {
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
      />,
    );

    const table = container.querySelector("table");
    expect(table?.className).toContain("table-fixed");
    expect(table?.getAttribute("style")).toContain(
      `width: ${(nights.length + 1) * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
    );

    const columns = Array.from(container.querySelectorAll("col"));
    expect(columns).toHaveLength(nights.length + 1);
    expect(
      columns.every((column) =>
        column.className.includes(BED_ALLOCATION_COLUMN_WIDTH_CLASS),
      ),
    ).toBe(true);

    const fixedCells = Array.from(
      container.querySelectorAll("th, td"),
    ).filter((cell) =>
      cell.className.includes(BED_ALLOCATION_COLUMN_WIDTH_CLASS),
    );
    expect(fixedCells).toHaveLength(nights.length * 2 + 2);
  });
});
