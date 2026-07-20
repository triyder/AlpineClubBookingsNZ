import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { getTodayDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

export interface CompleteBookingsResult {
  completedCount: number;
  completedBookingIds: string[];
}

/**
 * Transition PAID bookings to COMPLETED once their check-out date has fully
 * passed (issue #2029). Runs daily. A booking stays PAID — and therefore
 * editable/extendable — through the ENTIRE check-out day (NZ time): guests may
 * still be at the lodge on their check-out morning and must be able to extend
 * their stay. The stay is only "completed" once the NZ calendar date is
 * strictly AFTER `checkOut` (`checkOut < today`), i.e. from the first cron run
 * after 11:59pm NZ on the check-out date. `checkOut` is the departure date
 * (exclusive of the last night), so `checkOut < today` means every booked
 * night, and the whole check-out day, is behind us.
 */
export async function completeBookings(): Promise<CompleteBookingsResult> {
  const today = getTodayDateOnly();

  const bookingsToComplete = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PAID,
      checkOut: { lt: today },
    },
    select: { id: true, checkIn: true, checkOut: true },
  });

  if (bookingsToComplete.length === 0) {
    return { completedCount: 0, completedBookingIds: [] };
  }

  const ids = bookingsToComplete.map((b) => b.id);

  await prisma.booking.updateMany({
    where: { id: { in: ids } },
    data: { status: BookingStatus.COMPLETED },
  });
  for (const booking of bookingsToComplete) {
    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });
  }

  logger.info(
    { job: "complete-bookings", count: ids.length },
    "Transitioned PAID bookings to COMPLETED"
  );

  return { completedCount: ids.length, completedBookingIds: ids };
}
