import { prisma } from "./prisma";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export { getLodgeCapacity } from "@/lib/lodge-capacity";

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}

function getMonthStartDateOnly(year: number, month: number): Date {
  const date = parseDateOnly(
    `${year}-${String(month + 1).padStart(2, "0")}-01`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month for availability: ${year}-${month + 1}`);
  }

  return date;
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

type OccupancyBooking = {
  checkIn?: Date | null;
  checkOut?: Date | null;
  guests?: GuestStayRange[] | null;
};

type OccupancyIndexEntry = {
  booking: OccupancyBooking;
  checkIn: Date;
  checkOut: Date;
  checkInKey: string;
  checkOutKey: string;
};

/**
 * Precompute each booking's date-only keys once (#1146). The occupancy loops
 * evaluate every (night, booking) pair, so formatting the booking range per
 * pair made month availability and capacity checks O(nights x bookings)
 * timezone conversions; the index makes each pair a string comparison.
 */
function buildOccupancyIndex(bookings: OccupancyBooking[]): OccupancyIndexEntry[] {
  const index: OccupancyIndexEntry[] = [];
  for (const booking of bookings) {
    if (!booking.checkIn || !booking.checkOut) {
      continue;
    }
    index.push({
      booking,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      checkInKey: formatDateOnlyForTimeZone(booking.checkIn),
      checkOutKey: formatDateOnlyForTimeZone(booking.checkOut),
    });
  }
  return index;
}

function getOccupiedBedsForNightFromIndex(
  night: Date,
  index: OccupancyIndexEntry[]
): number {
  const nightKey = formatDateOnly(night);
  let occupiedBeds = 0;

  for (const entry of index) {
    if (nightKey >= entry.checkInKey && nightKey < entry.checkOutKey) {
      occupiedBeds += countActiveGuestsForNight(entry.booking.guests, night, {
        checkIn: entry.checkIn,
        checkOut: entry.checkOut,
      });
    }
  }

  return occupiedBeds;
}

export function getOccupiedBedsForNight(
  night: Date,
  bookings: OccupancyBooking[]
): number {
  return getOccupiedBedsForNightFromIndex(night, buildOccupancyIndex(bookings));
}

/**
 * Check if there's enough capacity for a given number of guests across all nights.
 */
export async function checkCapacity(
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNightFromIndex(night, occupancyIndex);

    return {
      date: night,
      occupiedBeds,
      availableBeds: lodgeCapacity - occupiedBeds,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available: minAvailable >= guestCount,
    minAvailable,
    nightDetails,
  };
}

export async function checkCapacityForGuestRanges(
  checkIn: Date,
  checkOut: Date,
  guests: GuestStayRange[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  if (nights.length === 0) {
    return { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  }

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNightFromIndex(night, occupancyIndex);
    const proposedBeds = countActiveGuestsForNight(guests, night, {
      checkIn: start,
      checkOut: exclusiveEnd,
    });

    return {
      date: night,
      occupiedBeds: occupiedBeds + proposedBeds,
      availableBeds: lodgeCapacity - occupiedBeds - proposedBeds,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available: minAvailable >= 0,
    minAvailable,
    nightDetails,
  };
}

/**
 * Get a monthly availability summary for calendar display.
 */
export async function getMonthAvailability(
  year: number,
  month: number
): Promise<Map<string, number>> {
  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const availability = new Map<string, number>();
  const nights = eachDateOnlyInRange(startDate, endDate);
  const occupancyIndex = buildOccupancyIndex(overlappingBookings);

  for (const night of nights) {
    const occupiedBeds = getOccupiedBedsForNightFromIndex(night, occupancyIndex);

    const key = formatDateOnly(night);
    availability.set(key, occupiedBeds);
  }

  return availability;
}
