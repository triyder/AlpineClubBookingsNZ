"use client";

import { useDroppable } from "@dnd-kit/core";
import { CircleDashed, Lock } from "lucide-react";
import { isCapacityHoldingBookingStatus } from "@/lib/booking-status";
import { cn } from "@/lib/utils";
import { GuestChip } from "./guest-chip";
import {
  BUCKET_DROPPABLE_ID,
  type BedOption,
  type BucketGuestGroup,
  type DashboardBookingSummary,
} from "./types";

interface BucketBoardProps {
  bookings: DashboardBookingSummary[];
  groupsByBooking: Map<string, BucketGuestGroup[]>;
  bedOptions: BedOption[];
  selectedBeds: Record<string, string>;
  onSelectBed: (bookingGuestId: string, bedId: string) => void;
  onAllocate: (group: BucketGuestGroup) => void;
  pendingGuestIds: Set<string>;
  highlightedBookingId: string;
}

export function BucketBoard({
  bookings,
  groupsByBooking,
  bedOptions,
  selectedBeds,
  onSelectBed,
  onAllocate,
  pendingGuestIds,
  highlightedBookingId,
}: BucketBoardProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: BUCKET_DROPPABLE_ID,
    data: { type: "bucket" },
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
        isOver && "border-blue-300 bg-blue-50",
      )}
    >
      {bookingsWithGroups.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          No bookings awaiting allocation in this range.
          {isOver ? " Drop here to unallocate a bed." : ""}
        </div>
      ) : (
        bookingsWithGroups.map((booking) => {
          const groups = groupsByBooking.get(booking.id) ?? [];
          // Match the board's Held/Provisional state (#1251) so a booking reads
          // the same before and after its guests are placed on beds.
          const holdsCapacity = isCapacityHoldingBookingStatus(booking.status);
          return (
            <div
              key={booking.id}
              className={cn(
                "rounded-md border bg-slate-50 p-2",
                booking.id === highlightedBookingId && "border-amber-300 bg-amber-50",
              )}
            >
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
                      ? "bg-foreground/10 text-foreground"
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
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                    Linked party · provisional non-member guests
                  </span>
                ) : memberBookingIdsWithChildren.has(booking.id) ? (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                    Linked party · member booking
                  </span>
                ) : null}
                {booking.requestedRoom &&
                  (booking.requestedRoom.active ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                      Requested: {booking.requestedRoom.name}
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
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
                    selectedBedId={selectedBeds[group.bookingGuestId] ?? ""}
                    onSelectBed={(bedId) => onSelectBed(group.bookingGuestId, bedId)}
                    onAllocate={() => onAllocate(group)}
                    pending={pendingGuestIds.has(group.bookingGuestId)}
                    highlighted={booking.id === highlightedBookingId}
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
