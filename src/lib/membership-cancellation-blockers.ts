import type { Prisma } from "@prisma/client";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

export type MembershipCancellationBlocker = {
  type: "owned_booking" | "guest_appearance";
  bookingId: string;
  bookingStatus: string;
  checkIn: string;
  checkOut: string;
  guestAppearanceId?: string;
};

export type MembershipCancellationBlockerClient =
  | typeof prisma
  | Prisma.TransactionClient;

export function emptyMembershipCancellationBlockerMap(memberIds: readonly string[]) {
  return new Map(
    memberIds.map((memberId) => [
      memberId,
      [] as MembershipCancellationBlocker[],
    ]),
  );
}

export async function loadMembershipCancellationBlockersByMemberId(
  memberIds: readonly string[],
  db: MembershipCancellationBlockerClient = prisma,
) {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId =
    emptyMembershipCancellationBlockerMap(uniqueMemberIds);
  if (uniqueMemberIds.length === 0) return blockersByMemberId;

  const today = getTodayDateOnly();
  const [ownedBookings, guestAppearances] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: { in: uniqueMemberIds },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        checkOut: { gt: today },
      },
      select: {
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        status: true,
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    }),
    db.bookingGuest.findMany({
      where: {
        memberId: { in: uniqueMemberIds },
        stayEnd: { gt: today },
        booking: {
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
      },
      select: {
        id: true,
        memberId: true,
        stayStart: true,
        stayEnd: true,
        booking: {
          select: {
            id: true,
            status: true,
            checkIn: true,
            checkOut: true,
          },
        },
      },
      orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    }),
  ]);

  for (const booking of ownedBookings) {
    blockersByMemberId.get(booking.memberId)?.push({
      type: "owned_booking",
      bookingId: booking.id,
      bookingStatus: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
    });
  }

  for (const guest of guestAppearances) {
    if (!guest.memberId) continue;
    blockersByMemberId.get(guest.memberId)?.push({
      type: "guest_appearance",
      bookingId: guest.booking.id,
      bookingStatus: guest.booking.status,
      checkIn: guest.stayStart.toISOString(),
      checkOut: guest.stayEnd.toISOString(),
      guestAppearanceId: guest.id,
    });
  }

  return blockersByMemberId;
}
