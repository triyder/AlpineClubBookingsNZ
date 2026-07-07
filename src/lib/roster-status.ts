import { parseOccupancyMonth } from "@/lib/admin-occupancy";
import {
  getActiveGuestsForNight,
  type BookingStayRange,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

/**
 * Per-date colour status for the roster calendar overlay. Precedence, first
 * match wins: no-guests → needs-roster → suggested → needs-attention →
 * confirmed. See `computeRosterDayStatuses` for the exact algorithm.
 */
export type RosterDayStatus =
  | "no-guests"
  | "needs-roster"
  | "suggested"
  | "needs-attention"
  | "confirmed";

/**
 * A guest as far as roster-status cares: the stay-range fields the active-night
 * primitive needs, plus an optional age tier for the adult/youth attention knob.
 */
export type RosterStatusGuest = GuestStayRange & { ageTier?: string | null };

/**
 * A staying booking. Structurally compatible with `getActiveGuestsForNight`
 * (it extends `BookingStayRange`), so a Prisma booking row selecting
 * checkIn/checkOut plus its guests can be passed straight through.
 */
export type RosterStatusBooking = BookingStayRange & {
  id: string;
  guests: RosterStatusGuest[];
};

/**
 * A chore assignment row projected to what roster-status needs. `bookingId` is
 * NON-NULL on the schema and is the sole coverage key: a row with a NULL
 * `bookingGuestId` still covers its booking, so we never track the guest here.
 */
export type RosterStatusAssignment = {
  date: Date;
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED";
  bookingId: string;
};

export type RosterDayStatusResult = {
  date: string;
  status: RosterDayStatus;
  stayingBookingCount: number;
  uncoveredBookingCount: number;
};

const ATTENTION_AGE_TIERS = new Set(["ADULT", "YOUTH"]);

/**
 * Pure roster-day status computation. No prisma import — shared with the kiosk
 * week endpoint. Coverage is diffed at BOOKING granularity (owner decision):
 * a booking is "covered" for a date iff at least one confirmed/completed chore
 * assignment row carries its booking id for that date.
 *
 * Per date (parsed with `parseDateOnly`):
 *   1. stayingBookings = bookings with ≥1 active guest that night.
 *      none → `no-guests`.
 *   2. dateAssignments = assignments whose `formatDateOnly(date)` matches.
 *      none → `needs-roster`.
 *   3. any SUGGESTED assignment → `suggested`.
 *   4. otherwise (all CONFIRMED/COMPLETED): uncovered = staying bookings whose
 *      id is not in the covered set. With `requireAdultOrYouthForAttention`,
 *      only bookings with ≥1 active ADULT/YOUTH guest count as relevant.
 *      any uncovered → `needs-attention`; else → `confirmed`.
 */
export function computeRosterDayStatuses(
  dates: string[],
  bookings: RosterStatusBooking[],
  assignments: RosterStatusAssignment[],
  options?: { requireAdultOrYouthForAttention?: boolean },
): RosterDayStatusResult[] {
  const requireAdultOrYouth = options?.requireAdultOrYouthForAttention ?? false;

  return dates.map((dateString) => {
    const night = parseDateOnly(dateString);

    const stayingBookings: Array<{
      booking: RosterStatusBooking;
      activeGuests: RosterStatusGuest[];
    }> = [];
    for (const booking of bookings) {
      const activeGuests = getActiveGuestsForNight(booking.guests, night, booking);
      if (activeGuests.length > 0) {
        stayingBookings.push({ booking, activeGuests });
      }
    }

    if (stayingBookings.length === 0) {
      return {
        date: dateString,
        status: "no-guests",
        stayingBookingCount: 0,
        uncoveredBookingCount: 0,
      };
    }

    const dateAssignments = assignments.filter(
      (assignment) => formatDateOnly(assignment.date) === dateString,
    );

    if (dateAssignments.length === 0) {
      return {
        date: dateString,
        status: "needs-roster",
        stayingBookingCount: stayingBookings.length,
        uncoveredBookingCount: 0,
      };
    }

    if (dateAssignments.some((assignment) => assignment.status === "SUGGESTED")) {
      return {
        date: dateString,
        status: "suggested",
        stayingBookingCount: stayingBookings.length,
        uncoveredBookingCount: 0,
      };
    }

    const coveredBookingIds = new Set(
      dateAssignments.map((assignment) => assignment.bookingId),
    );

    const relevantBookings = requireAdultOrYouth
      ? stayingBookings.filter(({ activeGuests }) =>
          activeGuests.some(
            (guest) => guest.ageTier != null && ATTENTION_AGE_TIERS.has(guest.ageTier),
          ),
        )
      : stayingBookings;

    const uncovered = relevantBookings.filter(
      ({ booking }) => !coveredBookingIds.has(booking.id),
    );

    if (uncovered.length > 0) {
      return {
        date: dateString,
        status: "needs-attention",
        stayingBookingCount: stayingBookings.length,
        uncoveredBookingCount: uncovered.length,
      };
    }

    return {
      date: dateString,
      status: "confirmed",
      stayingBookingCount: stayingBookings.length,
      uncoveredBookingCount: 0,
    };
  });
}

/**
 * DB-touching entry point. Loads operational bookings and chore assignments for
 * a calendar month, then delegates to the pure `computeRosterDayStatuses`. The
 * booking query mirrors `getAdminOccupancyMonth` (same operational filter and
 * overlap window) and additionally selects each guest's `ageTier` so the
 * adult/youth attention knob is available to callers that want it.
 */
export async function getRosterMonthStatus(input: {
  month: string;
}): Promise<RosterDayStatusResult[]> {
  const parsedMonth = parseOccupancyMonth(input.month);
  if (!parsedMonth.ok) {
    throw new Error(parsedMonth.error);
  }
  const { startDate, endDate } = parsedMonth;

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      deletedAt: null,
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      guests: {
        some: {
          stayStart: { lt: endDate },
          stayEnd: { gt: startDate },
        },
      },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          nights: {
            select: {
              stayDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const assignments = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: startDate, lt: endDate },
    },
    select: {
      date: true,
      status: true,
      bookingId: true,
    },
  });

  const dates = eachDateOnlyInRange(startDate, endDate).map(formatDateOnly);

  return computeRosterDayStatuses(dates, bookings, assignments);
}
