"use client";

import { useDroppable } from "@dnd-kit/core";
import { Focus } from "lucide-react";
import { cn } from "@/lib/utils";
import { AllocationChip } from "./allocation-chip";
import {
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  cellDroppableId,
} from "./types";

export const BED_ALLOCATION_COLUMN_WIDTH_REM = 11;
export const BED_ALLOCATION_COLUMN_WIDTH_CLASS =
  "w-[11rem] min-w-[11rem] max-w-[11rem]";

// The label column (room name header / bed name cells) needs more room than a
// date column: bed names like "Bunk Bed Lower Right" truncated illegibly at
// the shared 11rem width (#2150). Kept as its own fixed-width constant (never
// w-auto) so use-synced-scroll's scrollLeft sync — which assumes every room
// table renders the exact same total width — still lines every column up
// across rooms.
export const BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM = 14;
export const BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS =
  "w-[14rem] min-w-[14rem] max-w-[14rem]";

interface BoardCellProps {
  bedId: string;
  roomId: string;
  stayDate: string;
  // #1701: a shared DOUBLE bed-night holds up to two occupants (primary first).
  allocations: DashboardAllocation[];
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (allocation: DashboardAllocation, bedId: string) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  pendingAllocationIds: Set<string>;
  highlightedBookingId: string;
  activeDragLane?: boolean;
  // Tri-state (#2065): `undefined` while the client session resolves; the
  // `!canEdit` idiom treats that as disabled, so no truthy default here.
  canEdit: boolean | undefined;
}

export function BoardCell({
  bedId,
  roomId,
  stayDate,
  allocations,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  pendingAllocationIds,
  highlightedBookingId,
  activeDragLane,
  canEdit,
}: BoardCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellDroppableId(bedId, stayDate),
    data: { type: "cell", bedId, roomId, stayDate },
    disabled: !canEdit,
  });

  const highlighted = allocations.some(
    (allocation) => allocation.bookingId === highlightedBookingId,
  );

  return (
    <td
      ref={setNodeRef}
      data-stay-date={stayDate}
      data-active-drag-lane={activeDragLane ? "true" : undefined}
      className={cn(
        BED_ALLOCATION_COLUMN_WIDTH_CLASS,
        "overflow-hidden border p-1 align-top",
        activeDragLane && "bg-accent",
        highlighted &&
          !isOver &&
          "border-2 border-dashed border-warning bg-warning-muted",
        isOver && "bg-info-muted ring-2 ring-info",
      )}
    >
      {highlighted ? (
        <span className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
          <Focus aria-hidden className="h-3 w-3" />
          Focused
        </span>
      ) : null}
      {allocations.length > 0 ? (
        <div className="flex flex-col gap-1">
          {allocations.map((allocation) => (
            <div key={allocation.id}>
              {allocation.isSecondOccupant ? (
                <span className="mb-0.5 block text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  Shares bed · partner
                </span>
              ) : null}
              <AllocationChip
                allocation={allocation}
                bedOptions={bedOptions}
                bedOptionGroups={bedOptionGroups}
                onReassignBed={(targetBedId) => onReassignBed(allocation, targetBedId)}
                onRemove={() => onRemove(allocation)}
                pending={pendingAllocationIds.has(allocation.id)}
                canEdit={canEdit}
              />
            </div>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            "flex h-12 items-center justify-center rounded-md border border-dashed border-transparent text-[10px] text-muted-foreground",
            isOver && "border-info/60 text-info",
          )}
        >
          {isOver ? "Drop here" : ""}
        </div>
      )}
    </td>
  );
}
