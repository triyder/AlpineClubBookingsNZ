"use client";

import { useDroppable } from "@dnd-kit/core";
import { CircleDashed, Inbox, Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { getBookingAccent } from "./booking-accent";
import { GuestChip } from "./guest-chip";
import {
  BUCKET_DROPPABLE_ID,
  type BedOption,
  type BedOptionGroup,
  type BucketGuestGroup,
  type DashboardBookingSummary,
} from "./types";

interface BucketBoardProps {
  bookings: DashboardBookingSummary[];
  groupsByBooking: Map<string, BucketGuestGroup[]>;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  selectedBeds: Record<string, string>;
  onSelectBed: (bookingGuestId: string, bedId: string) => void;
  onAllocate: (group: BucketGuestGroup) => void;
  pendingGuestIds: Set<string>;
  highlightedBookingId: string;
  canEdit?: boolean;
}

export function BucketBoard({
  bookings,
  groupsByBooking,
  bedOptions,
  bedOptionGroups = [],
  selectedBeds,
  onSelectBed,
  onAllocate,
  pendingGuestIds,
  highlightedBookingId,
  canEdit = true,
}: BucketBoardProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: BUCKET_DROPPABLE_ID,
    data: { type: "bucket" },
    disabled: !canEdit,
  });

  const bookingsWithGroups = bookings.filter(
    (booking) => (groupsByBooking.get(booking.id)?.length ?? 0) > 0,
  );

  // Split-booking grouping (#738): a mixed party is two linked bookings — a
  // member booking and a provisional non-member child. Label both so the board
  // reads them as one party.
  const memberBookingIdsWithChildren = new Set(
    bookings
      .map((booking) => booking.parentBookingId)
      .filter((id): id is string => Boolean(id)),
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "space-y-3 rounded-md border border-dashed p-3 transition-colors",
        isOver && "border-info bg-info-muted",
      )}
    >
      {bookingsWithGroups.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No bookings awaiting allocation"
          description={
            isOver
              ? "Drop here to unallocate a bed."
              : "Approved bookings still needing a bed in this range appear here."
          }
          className="py-8"
        />
      ) : (
        bookingsWithGroups.map((booking) => {
          const groups = groupsByBooking.get(booking.id) ?? [];
          // Match the board's Held/Provisional state (#1251) so a booking reads
          // the same before and after its guests are placed on beds. Server
          // precomputes it (bookingHoldsCapacity) because an accepted-but-unpaid
          // quote is PENDING but holds (#1254).
          const holdsCapacity = booking.holdsCapacity;
          const accent = getBookingAccent(booking.id);
          const bookingTitle = `Booking ${booking.id}`;
          return (
            <div
              key={booking.id}
              title={bookingTitle}
              className={cn(
                "relative overflow-hidden rounded-md border bg-card p-2 pl-3 text-card-foreground ring-1 ring-inset",
                accent.ringClassName,
                booking.id === highlightedBookingId &&
                  "border-warning bg-warning-muted dark:bg-warning-muted",
              )}
            >
              <span
                aria-hidden="true"
                className={cn("absolute inset-y-0 left-0 w-1", accent.stripClassName)}
              />
              <div className="mb-2 flex flex-wrap items-baseline gap-2 px-1">
                <span className="text-sm font-semibold">{booking.memberName}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {booking.id}
                </span>
                <span className="text-xs text-muted-foreground">
                  {booking.checkIn} – {booking.checkOut}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                    holdsCapacity
                      ? "bg-secondary text-secondary-foreground"
                      : "border border-dashed border-muted-foreground/60 text-muted-foreground",
                  )}
                  title={
                    holdsCapacity
                      ? "Held — this booking holds its beds for the night."
                      : "Provisional — this booking does not hold the night; beds can still be booked by someone else."
                  }
                >
                  {holdsCapacity ? (
                    <Lock className="h-3 w-3" aria-hidden />
                  ) : (
                    <CircleDashed className="h-3 w-3" aria-hidden />
                  )}
                  {holdsCapacity ? "Held" : "Provisional"}
                </span>
                {booking.parentBookingId ? (
                  <span className="rounded-full bg-info-muted px-2 py-0.5 text-xs font-medium text-info">
                    Linked party · provisional non-member guests
                  </span>
                ) : memberBookingIdsWithChildren.has(booking.id) ? (
                  <span className="rounded-full bg-info-muted px-2 py-0.5 text-xs font-medium text-info">
                    Linked party · member booking
                  </span>
                ) : null}
                {booking.requestedRoom &&
                  (booking.requestedRoom.active ? (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                      Requested: {booking.requestedRoom.name}
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning">
                      Requested room no longer active: {booking.requestedRoom.name}
                    </span>
                  ))}
              </div>
              <div className="space-y-2">
                {groups.map((group) => (
                  <GuestChip
                    key={group.bookingGuestId}
                    group={group}
                    bedOptions={bedOptions}
                    bedOptionGroups={bedOptionGroups}
                    selectedBedId={selectedBeds[group.bookingGuestId] ?? ""}
                    onSelectBed={(bedId) => onSelectBed(group.bookingGuestId, bedId)}
                    onAllocate={() => onAllocate(group)}
                    pending={pendingGuestIds.has(group.bookingGuestId)}
                    highlighted={booking.id === highlightedBookingId}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
