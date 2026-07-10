"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CircleDashed, GripVertical, Lock, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  allocationDraggableId,
} from "./types";

interface AllocationChipProps {
  allocation: DashboardAllocation;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (bedId: string) => void;
  onRemove: () => void;
  pending: boolean;
  canEdit?: boolean;
}

export function AllocationChip({
  allocation,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  pending,
  canEdit = true,
}: AllocationChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: allocationDraggableId(allocation.id),
      data: { type: "allocation", allocationId: allocation.id },
      disabled: !canEdit,
    });

  const optionGroups =
    bedOptionGroups.length > 0
      ? bedOptionGroups
      : bedOptions.reduce<BedOptionGroup[]>((groups, bed) => {
          const existing = groups.find((group) => group.roomId === bed.roomId);
          if (existing) {
            existing.beds.push(bed);
          } else {
            groups.push({
              roomId: bed.roomId,
              roomName: bed.roomName,
              beds: [bed],
            });
          }
          return groups;
        }, []);

  const otherBedGroups = optionGroups
    .map((group) => ({
      ...group,
      beds: group.beds.filter((bed) => bed.id !== allocation.bedId),
    }))
    .filter((group) => group.beds.length > 0);

  // Issue #1251: a bed on a capacity-holding booking (booked/confirmed) holds
  // the night; a bed on a provisional booking (generic PENDING / PAYMENT_PENDING
  // / WAITLIST_OFFERED) does NOT. Holding is no longer a pure function of status
  // (an accepted-but-unpaid quote is PENDING but holds, #1254), so the server
  // precomputes the flag via bookingHoldsCapacity(). The signal is NOT
  // colour-only — border style, icon, and label all differ — so it survives in
  // either theme and for colour-blind staff.
  const holdsCapacity = allocation.holdsCapacity;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "flex w-full max-w-full items-start gap-1 rounded-md border p-1.5 text-xs shadow-sm",
        holdsCapacity
          ? "border-border bg-card text-card-foreground"
          : "border-dashed border-muted-foreground/50 bg-muted/40 text-foreground",
        isDragging && "opacity-50",
        pending && "opacity-60",
      )}
    >
      <button
        type="button"
        aria-label={`Drag ${allocation.guestName} to another bed or night`}
        disabled={!canEdit}
        title={!canEdit ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-accent active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{allocation.guestName}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {allocation.bookingId}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge
            variant="outline"
            className={cn(
              "gap-1 px-1 py-0 text-[10px]",
              holdsCapacity
                ? "border-transparent bg-foreground/10 font-semibold text-foreground"
                : "border-dashed border-muted-foreground/60 text-muted-foreground",
            )}
            title={
              holdsCapacity
                ? "Held — this booking holds the bed for the night."
                : "Provisional — this booking does not hold the night; the bed can still be booked by someone else."
            }
          >
            {holdsCapacity ? (
              <Lock className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <CircleDashed className="h-2.5 w-2.5" aria-hidden />
            )}
            {holdsCapacity ? "Held" : "Provisional"}
          </Badge>
          <Badge
            variant={allocation.source === "MANUAL" ? "warning" : "secondary"}
            className="px-1 py-0 text-[10px]"
          >
            {allocation.source}
          </Badge>
          <Badge
            variant={allocation.approvedAt ? "success" : "outline"}
            className="px-1 py-0 text-[10px]"
          >
            {allocation.approvedAt ? "Approved" : "Draft"}
          </Badge>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            aria-label={`Manage allocation for ${allocation.guestName}`}
            disabled={pending || !canEdit}
            title={!canEdit ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
          >
            <X className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="bed-allocation-move-menu max-h-[min(60vh,20rem)] overflow-y-auto"
        >
          <DropdownMenuLabel>Move to bed</DropdownMenuLabel>
          {otherBedGroups.map((group) => (
            <DropdownMenuSub key={group.roomId}>
              <DropdownMenuSubTrigger
                aria-label={`Move ${allocation.guestName} to a bed in ${group.roomName}`}
              >
                {group.roomName}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                collisionPadding={8}
                className="bed-allocation-move-submenu max-h-[min(60vh,18rem)] overflow-y-auto"
              >
                {group.beds.map((bed) => (
                  <DropdownMenuItem
                    key={bed.id}
                    aria-label={`Move ${allocation.guestName} to ${bed.label}`}
                    onSelect={() => onReassignBed(bed.id)}
                  >
                    {bed.bedName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove} className="text-destructive">
            Remove allocation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
