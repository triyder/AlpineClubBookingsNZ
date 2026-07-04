import type { BookingStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// test seam
// Booking statuses that represent a stay that has been committed (paid/confirmed
// or completed). Drafts, pending, cancelled, bumped and waitlisted bookings do
// not count toward a member's nights stayed.
export const COMMITTED_BOOKING_STATUSES: BookingStatus[] = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
];

type StayNightsClient = Pick<typeof prisma, "bookingGuestNight">;

/**
 * Count the distinct nights a member has personally stayed at the lodge.
 *
 * Counts distinct stay dates across the member's own member-guest rows
 * (BookingGuest.isMember = true, memberId = member) in committed, non-deleted
 * bookings. Used by the nomination eligibility gate.
 */
export async function countMemberStayNights(
  memberId: string,
  client: StayNightsClient = prisma,
): Promise<number> {
  const where: Prisma.BookingGuestNightWhereInput = {
    bookingGuest: {
      isMember: true,
      memberId,
      booking: {
        status: { in: COMMITTED_BOOKING_STATUSES },
        deletedAt: null,
      },
    },
  };

  const rows = await client.bookingGuestNight.findMany({
    where,
    select: { stayDate: true },
    distinct: ["stayDate"],
  });

  return rows.length;
}
