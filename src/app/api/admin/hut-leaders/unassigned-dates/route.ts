import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";

/**
 * GET /api/admin/hut-leaders/unassigned-dates
 * Returns dates in the next 14 days that have paid/operational bookings but no HutLeaderAssignment.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const today = getTodayDateOnly();
  const endDate = addDaysDateOnly(today, 14);

  // Get all hut leader assignments covering the next 14 days
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      startDate: { lte: endDate },
      endDate: { gte: today },
    },
    select: { startDate: true, endDate: true },
  });

  // Get all bookings in the next 14 days
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: endDate },
      checkOut: { gt: today },
    },
    select: {
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          stayStart: true,
          stayEnd: true,
        },
      },
    },
  });

  function isDateCovered(date: Date): boolean {
    return assignments.some(
      (a) => a.startDate.getTime() <= date.getTime() && a.endDate.getTime() >= date.getTime()
    );
  }

  function getBookingStats(date: Date): { bookingCount: number; guestCount: number } {
    let bookingCount = 0;
    let guestCount = 0;
    for (const b of bookings) {
      if (b.checkIn.getTime() <= date.getTime() && b.checkOut.getTime() > date.getTime()) {
        const legacyGuestCount = (b as { _count?: { guests?: number } })._count?.guests ?? 0;
        const activeGuestCount = Array.isArray(b.guests)
          ? countActiveGuestsForNight(b.guests, date, b)
          : legacyGuestCount;

        if (activeGuestCount > 0) {
          bookingCount++;
          guestCount += activeGuestCount;
        }
      }
    }
    return { bookingCount, guestCount };
  }

  const unassignedDates: { date: string; bookingCount: number; guestCount: number }[] = [];

  for (let day = today; day.getTime() <= endDate.getTime(); day = addDaysDateOnly(day, 1)) {
    if (isDateCovered(day)) continue;
    const stats = getBookingStats(day);
    if (stats.bookingCount > 0) {
      unassignedDates.push({
        date: formatDateOnly(day),
        bookingCount: stats.bookingCount,
        guestCount: stats.guestCount,
      });
    }
  }

  return NextResponse.json({ unassignedDates });
}
