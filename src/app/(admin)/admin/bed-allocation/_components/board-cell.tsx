"use client";

import { useDroppable } from "@dnd-kit/core";
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

interface BoardCellProps {
  bedId: string;
  roomId: string;
  stayDate: string;
  allocation: DashboardAllocation | undefined;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (allocation: DashboardAllocation, bedId: string) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  pending: boolean;
  highlighted?: boolean;
  canEdit?: boolean;
}

export function BoardCell({
  bedId,
  roomId,
  stayDate,
  allocation,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  pending,
  highlighted,
  canEdit = true,
}: BoardCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellDroppableId(bedId, stayDate),
    data: { type: "cell", bedId, roomId, stayDate },
    disabled: !canEdit,
  });

  return (
    <td
      ref={setNodeRef}
      className={cn(
        BED_ALLOCATION_COLUMN_WIDTH_CLASS,
        "overflow-hidden border p-1 align-top",
        isOver && "bg-blue-50 ring-2 ring-blue-300",
        highlighted && !isOver && "bg-amber-50",
      )}
    >
      {allocation ? (
        <AllocationChip
          allocation={allocation}
          bedOptions={bedOptions}
          bedOptionGroups={bedOptionGroups}
          onReassignBed={(targetBedId) => onReassignBed(allocation, targetBedId)}
          onRemove={() => onRemove(allocation)}
          pending={pending}
          canEdit={canEdit}
        />
      ) : (
        <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-transparent text-[10px] text-muted-foreground/50">
          {isOver ? "Drop here" : ""}
        </div>
      )}
    </td>
  );
}
