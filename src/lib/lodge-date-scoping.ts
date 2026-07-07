import { prisma } from "@/lib/prisma";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";

export const LODGE_VISIBLE_BOOKING_STATUSES = [
  ...OPERATIONAL_STAY_BOOKING_STATUSES,
] as const;

// lodgeId is optional so existing (pre-phase-5) callers keep club-wide
// behaviour; kiosk routes pass the resolved lodge to scope the lookup
// (docs/multi-lodge/lodge-scoping-contract.md — roster/guest lookups are
// null-tolerant while lodgeId backfill is not yet enforced NOT NULL).
export async function findLodgeGuestForDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string
) {
  return prisma.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      stayStart: { lte: date },
      stayEnd: { gt: date },
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so its guest resolves to null and the arrive
        // endpoint 404s — even though the guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
      firstName: true,
      lastName: true,
      memberId: true,
      arrivedAt: true,
      departedAt: true,
      booking: {
        select: {
          memberId: true,
        },
      },
    },
  });
}

export async function findLodgeGuestDepartingOnDate(
  bookingGuestId: string,
  date: Date,
  lodgeId?: string
) {
  return prisma.bookingGuest.findFirst({
    where: {
      id: bookingGuestId,
      stayStart: { lte: date },
      stayEnd: date,
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gte: date },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so its guest resolves to null and the depart
        // endpoint 404s — even though the guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
      firstName: true,
      lastName: true,
      memberId: true,
      arrivedAt: true,
      departedAt: true,
      booking: {
        select: {
          memberId: true,
        },
      },
    },
  });
}

export async function validateRosterAllocationsForDate(
  allocations: Array<{ bookingGuestId: string; bookingId: string }>,
  date: Date
) {
  const guestIds = Array.from(
    new Set(allocations.map((allocation) => allocation.bookingGuestId))
  );

  const guests = await prisma.bookingGuest.findMany({
    where: {
      id: { in: guestIds },
      stayStart: { lte: date },
      stayEnd: { gt: date },
      booking: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
        // Enforcement path (#1372 / #1422): keep excluding a booking blocked by
        // a pending admin review so roster-confirm rejects it — even though the
        // guest LIST now shows it flagged.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
    },
    select: {
      id: true,
      bookingId: true,
    },
  });

  const guestBookingMap = new Map(
    guests.map((guest) => [guest.id, guest.bookingId])
  );

  return allocations.every(
    (allocation) =>
      guestBookingMap.get(allocation.bookingGuestId) === allocation.bookingId
  );
}
