"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Focus, GripVertical } from "lucide-react";
import { AgeTierBadge } from "@/components/admin/family-groups/age-tier-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getBookingAccent } from "./booking-accent";
import {
  type BedOption,
  type BedOptionGroup,
  type BucketGuestGroup,
  bucketDraggableId,
} from "./types";

interface GuestChipProps {
  group: BucketGuestGroup;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  selectedBedId: string;
  onSelectBed: (bedId: string) => void;
  onAllocate: () => void;
  pending: boolean;
  highlighted?: boolean;
  canEdit?: boolean;
}

export function GuestChip({
  group,
  bedOptions,
  bedOptionGroups = [],
  selectedBedId,
  onSelectBed,
  onAllocate,
  pending,
  highlighted,
  canEdit = true,
}: GuestChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: bucketDraggableId(group.bookingGuestId),
      data: { type: "bucket-guest", bookingGuestId: group.bookingGuestId },
      disabled: !canEdit,
    });

  const nightsLabel =
    group.stayDates.length === 1
      ? group.stayDates[0]
      : `${group.stayDates[0]} – ${group.stayDates[group.stayDates.length - 1]} (${group.stayDates.length} nights)`;
  const optionGroups =
    bedOptionGroups.length > 0
      ? bedOptionGroups
      : bedOptions.reduce<BedOptionGroup[]>((groups, bed) => {
          const existing = groups.find((room) => room.roomId === bed.roomId);
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
  const selectedBed = bedOptions.find((bed) => bed.id === selectedBedId);
  const accent = getBookingAccent(group.bookingId);
  const bookingTitle = `Booking ${group.bookingId}`;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      title={bookingTitle}
      className={cn(
        "relative flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-2 pl-3 text-card-foreground shadow-sm ring-1 ring-inset sm:flex-row sm:items-center sm:justify-between",
        accent.ringClassName,
        isDragging && "opacity-50",
        highlighted &&
          "border-2 border-dashed border-warning bg-warning-muted dark:bg-warning-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1", accent.stripClassName)}
      />
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <button
          type="button"
          aria-label={`Drag ${group.guestName} to a bed`}
          disabled={!canEdit}
          title={!canEdit ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
          className="mt-0.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm font-medium">
            {highlighted ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                <Focus aria-hidden className="h-3 w-3" />
                Focused
              </span>
            ) : null}
            <span className="min-w-0 truncate" title={group.guestName}>
              {group.guestName}
            </span>
            <span className="shrink-0">
              <AgeTierBadge tier={group.guestAgeTier} />
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {group.memberName}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {nightsLabel}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={selectedBedId || "none"}
          onValueChange={onSelectBed}
          disabled={!canEdit}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Select bed">
              {selectedBed ? selectedBed.label : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select bed</SelectItem>
            {optionGroups.map((room) => (
              <SelectGroup key={room.roomId}>
                <SelectLabel>{room.roomName}</SelectLabel>
                {room.beds.map((bed) => (
                  <SelectItem key={bed.id} value={bed.id}>
                    {bed.bedName}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={onAllocate}
          disabled={
            !canEdit || pending || !selectedBedId || selectedBedId === "none"
          }
          title={!canEdit ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        >
          Allocate
        </Button>
        {group.stayDates.length > 1 ? (
          <Badge variant="outline">{group.stayDates.length} nights</Badge>
        ) : null}
      </div>
    </div>
  );
}
