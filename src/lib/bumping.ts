import { prisma } from "./prisma";
import { getLodgeCapacity } from "./capacity";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { Prisma } from "@prisma/client";
import { eachDayOfInterval, subDays, format } from "date-fns";
import {
  sendBookingBumpedEmail,
  sendBookingGuestsRemovedEmail,
  sendAdminBookingBumpedAlert,
} from "./email";
import logger from "@/lib/logger";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

export interface BumpResult {
  bumpedBookingIds: string[];
  // Bookings whose non-member guests were removed but kept their member
  // guests (the new default). These members get a "your guests didn't fit,
  // your booking continues" email rather than a bumped email.
  partiallyBumpedBookingIds: string[];
  capacityRestored: boolean;
}

/**
 * Calculate occupied beds per night for a date range, excluding specific booking IDs.
 * Only counts bookings that intentionally reserve capacity.
 */
export async function getOccupiedBedsPerNight(
  checkIn: Date,
  checkOut: Date,
  excludeBookingIds: string[] = [],
  tx?: Prisma.TransactionClient
): Promise<Map<string, number>> {
  const db = tx || prisma;
  const nights = eachDayOfInterval({
    start: checkIn,
    end: subDays(checkOut, 1),
  });

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingIds.length > 0
        ? { id: { notIn: excludeBookingIds } }
        : {}),
    },
    // Per-night sets (issue #713) so non-contiguous holders are counted only
    // on the nights they occupy; guests without rows use the envelope.
    include: { guests: { include: { nights: true } } },
  });

  const occupiedMap = new Map<string, number>();

  for (const night of nights) {
    const key = format(night, "yyyy-MM-dd");
    const activeGuestCount = overlappingBookings.reduce(
      (total, booking) =>
        total + countActiveGuestsForNight(booking.guests, night, booking),
      0
    );

    occupiedMap.set(key, activeGuestCount);
  }

  return occupiedMap;
}

/**
 * Check if capacity would be exceeded on any night after adding new guests.
 */
export function wouldExceedCapacity(
  occupiedBedsPerNight: Map<string, number>,
  newGuestCount: number,
  lodgeCapacity = FALLBACK_LODGE_CAPACITY,
): boolean {
  for (const [, occupied] of occupiedBedsPerNight) {
    if (occupied + newGuestCount > lodgeCapacity) {
      return true;
    }
  }
  return false;
}

function wouldExceedCapacityForGuestRanges(
  occupiedBedsPerNight: Map<string, number>,
  checkIn: Date,
  checkOut: Date,
  newGuests: number | GuestStayRange[],
  lodgeCapacity: number,
): boolean {
  for (const [dateKey, occupied] of occupiedBedsPerNight) {
    const proposedBeds = Array.isArray(newGuests)
      ? countActiveGuestsForNight(
          newGuests,
          new Date(`${dateKey}T00:00:00.000Z`),
          { checkIn, checkOut }
        )
      : newGuests;

    if (occupied + proposedBeds > lodgeCapacity) {
      return true;
    }
  }

  return false;
}

/**
 * Capacity-fit probe, retained from the pre-#738 synchronous bump.
 *
 * Before #738 this ran a most-recent-first bump of overlapping `PENDING`
 * bookings when a member booking would exceed capacity. Since #737/#738 a
 * `PENDING` booking holds no capacity (it is not in
 * `CAPACITY_HOLDING_BOOKING_STATUSES`), so bumping one frees nothing real. The
 * old algorithm still subtracted those never-counted `PENDING` guests from
 * occupancy, which could drive it below the true committed figure and let an
 * all-member booking be marked `PAID` into a full lodge (the R1 overbooking
 * carried into #738).
 *
 * This version can never manufacture capacity: it never marks a `PENDING`
 * booking `BUMPED` and only reports whether the incoming guests already fit
 * against the committed (capacity-holding) bookings. A caller that gets
 * `capacityRestored=false` must cancel-and-refund (priced) or reject ($0) — it
 * must not commit the booking to `PAID`. Split bookings (#738) remove the need
 * for synchronous bumping: the non-member portion is its own provisional
 * booking, resolved at the hold window in R3.
 */
export async function bumpPendingBookings(
  checkIn: Date,
  checkOut: Date,
  newGuests: number | GuestStayRange[],
  tx: Prisma.TransactionClient
): Promise<BumpResult> {
  const lodgeCapacity = await getLodgeCapacity(tx);
  const occupiedMap = await getOccupiedBedsPerNight(checkIn, checkOut, [], tx);

  return {
    bumpedBookingIds: [],
    partiallyBumpedBookingIds: [],
    capacityRestored: !wouldExceedCapacityForGuestRanges(
      occupiedMap,
      checkIn,
      checkOut,
      newGuests,
      lodgeCapacity
    ),
  };
}

/**
 * Send bumped notification emails for a list of booking IDs.
 * Called after the transaction commits so emails aren't sent on rollback.
 * @param triggeringMemberName - Name of the member whose booking triggered the bump (for admin alerts)
 */
export async function sendBumpedNotifications(
  bumpedBookingIds: string[],
  triggeringMemberName?: string
): Promise<void> {
  for (const bookingId of bumpedBookingIds) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, guests: true },
    });

    if (!booking) continue;

    try {
      await sendBookingBumpedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length
      );
    } catch (err) {
      logger.error({ err, bookingId }, "Failed to send bumped email");
    }

    // N-07: Send admin alert for each bumped booking
    sendAdminBookingBumpedAlert({
      bumpedMemberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      triggeringMemberName: triggeringMemberName || "Unknown",
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send admin bump alert")
    );
  }
}

/**
 * Notify members whose non-member guests were dropped (partial bump) that their
 * booking continues at the repriced amount. Called after the transaction
 * commits so emails aren't sent on rollback. No charge happens here — partial
 * bumps are pre-charge, so there is never a refund to mention.
 */
export async function sendPartialBumpNotifications(
  partiallyBumpedBookingIds: string[]
): Promise<void> {
  for (const bookingId of partiallyBumpedBookingIds) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, guests: true },
    });

    if (!booking) continue;

    try {
      await sendBookingGuestsRemovedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents
      );
    } catch (err) {
      logger.error(
        { err, bookingId },
        "Failed to send partial-bump (guests removed) email"
      );
    }
  }
}
