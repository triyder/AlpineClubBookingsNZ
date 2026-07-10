"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
  BoardCell,
} from "./board-cell";
import {
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  type DashboardRoom,
} from "./types";

interface RoomTableProps {
  room: DashboardRoom;
  nights: string[];
  allocationByBedAndDate: Map<string, DashboardAllocation>;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (allocation: DashboardAllocation, bedId: string) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  pendingAllocationIds: Set<string>;
  highlightedBookingId: string;
  canEdit?: boolean;
}

export function RoomTable({
  room,
  nights,
  allocationByBedAndDate,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  pendingAllocationIds,
  highlightedBookingId,
  canEdit = true,
}: RoomTableProps) {
  const activeBeds = room.beds.filter((bed) => bed.active);

  if (activeBeds.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table
        className="table-fixed"
        style={{
          width: `${(nights.length + 1) * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
        }}
      >
        <colgroup>
          {Array.from({ length: nights.length + 1 }, (_, index) => (
            <col key={index} className={BED_ALLOCATION_COLUMN_WIDTH_CLASS} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead
              className={`${BED_ALLOCATION_COLUMN_WIDTH_CLASS} sticky left-0 z-10 bg-background`}
            >
              <span className="block truncate">{room.name}</span>
            </TableHead>
            {nights.map((night) => (
              <TableHead
                key={night}
                className={`${BED_ALLOCATION_COLUMN_WIDTH_CLASS} text-center font-mono text-xs`}
              >
                <span className="block truncate">{night}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {activeBeds.map((bed) => (
            <TableRow key={bed.id}>
              <TableCell
                className={`${BED_ALLOCATION_COLUMN_WIDTH_CLASS} sticky left-0 z-10 bg-background font-medium`}
              >
                <span className="block truncate">{bed.name}</span>
              </TableCell>
              {nights.map((night) => {
                const allocation = allocationByBedAndDate.get(`${bed.id}:${night}`);
                return (
                  <BoardCell
                    key={night}
                    bedId={bed.id}
                    roomId={room.id}
                    stayDate={night}
                    allocation={allocation}
                    bedOptions={bedOptions}
                    bedOptionGroups={bedOptionGroups}
                    onReassignBed={onReassignBed}
                    onRemove={onRemove}
                    pending={
                      allocation ? pendingAllocationIds.has(allocation.id) : false
                    }
                    highlighted={allocation?.bookingId === highlightedBookingId}
                    canEdit={canEdit}
                  />
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
