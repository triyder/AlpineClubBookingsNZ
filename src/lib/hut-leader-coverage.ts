import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import {
  loadHutLeaderLookaheadDays,
  normalizeHutLeaderLookaheadDays,
  type LodgeSettingsReader,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";

export interface UnassignedHutLeaderDate {
  date: string;
  bookingCount: number;
  guestCount: number;
}

type HutLeaderBooking = {
  checkIn: Date;
  checkOut: Date;
  guests?: Array<{
    stayStart?: Date | null;
    stayEnd?: Date | null;
  }> | null;
  _count?: {
    guests?: number;
  };
};

type HutLeaderCoverageDb = LodgeSettingsReader & {
  booking: {
    findMany(args: unknown): Promise<HutLeaderBooking[]>;
  };
  hutLeaderAssignment: {
    findMany(args: unknown): Promise<Array<{ startDate: Date; endDate: Date }>>;
  };
};

export async function getUnassignedHutLeaderDates(input?: {
  db?: HutLeaderCoverageDb;
  lookAheadDays?: number;
  today?: Date;
  // Explicit date-only window. When BOTH are supplied they replace the
  // today→today+lookahead window (used to paint a calendar month, including
  // past nights for history). When absent, behaviour is exactly as before.
  from?: Date;
  to?: Date;
}): Promise<UnassignedHutLeaderDate[]> {
  const db = input?.db ?? (prisma as unknown as HutLeaderCoverageDb);
  const today = input?.today ?? getTodayDateOnly();

  const hasWindow = input?.from != null && input?.to != null;
  let windowStart: Date;
  let endDate: Date;
  if (hasWindow) {
    windowStart = input!.from!;
    endDate = input!.to!;
  } else {
    const lookAheadDays =
      input?.lookAheadDays ?? (await loadHutLeaderLookaheadDays(db));
    windowStart = today;
    endDate = addDaysDateOnly(
      today,
      normalizeHutLeaderLookaheadDays(lookAheadDays),
    );
  }

  const [assignments, bookings] = await Promise.all([
    db.hutLeaderAssignment.findMany({
      where: {
        startDate: { lte: endDate },
        endDate: { gte: windowStart },
      },
      select: { startDate: true, endDate: true },
    }),
    db.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { lte: endDate },
        checkOut: { gt: windowStart },
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
    }),
  ]);

  function isDateCovered(date: Date): boolean {
    return assignments.some(
      (assignment) =>
        assignment.startDate.getTime() <= date.getTime() &&
        assignment.endDate.getTime() >= date.getTime(),
    );
  }

  function getBookingStats(date: Date) {
    let bookingCount = 0;
    let guestCount = 0;

    for (const booking of bookings) {
      if (
        booking.checkIn.getTime() > date.getTime() ||
        booking.checkOut.getTime() <= date.getTime()
      ) {
        continue;
      }

      const legacyGuestCount = booking._count?.guests ?? 0;
      const activeGuestCount = Array.isArray(booking.guests)
        ? countActiveGuestsForNight(booking.guests, date, booking)
        : legacyGuestCount;

      if (activeGuestCount > 0) {
        bookingCount++;
        guestCount += activeGuestCount;
      }
    }

    return { bookingCount, guestCount };
  }

  const unassignedDates: UnassignedHutLeaderDate[] = [];

  for (
    let day = windowStart;
    day.getTime() <= endDate.getTime();
    day = addDaysDateOnly(day, 1)
  ) {
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

  return unassignedDates;
}
