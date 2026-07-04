import { prisma } from "./prisma";
import {
  addDaysDateOnly,
  formatDateOnly,
} from "./date-only";
import { LODGE_VISIBLE_BOOKING_STATUSES } from "./lodge-date-scoping";
import {
  hasAccessRole,
  hasAdminAccess,
  hasLodgeAccess,
  type AccessRoleInput,
} from "@/lib/access-roles";

export type KioskTier = "admin" | "hut-leader" | "lodge" | "staying-guest" | "none";

export interface KioskAccess {
  tier: KioskTier;
  dateRange: { minDate: string; maxDate: string } | null;
  canManageRoster: boolean;
  canMarkAttendance: boolean;
  canCompleteChores: boolean;
}

export type KioskAccessSubject = AccessRoleInput & {
  id: string;
};

/**
 * Returns the highest kiosk access tier for a user on a given date.
 */
export async function getKioskAccessTier(
  user: KioskAccessSubject,
  date: Date
): Promise<KioskTier> {
  if (hasAdminAccess(user)) return "admin";
  if (hasLodgeAccess(user)) return "lodge";

  if (hasAccessRole(user, "USER")) {
    // Check hut leader assignment: (startDate - 1 day) <= date <= endDate
    const nextDay = addDaysDateOnly(date, 1);

    const hutLeaderCount = await prisma.hutLeaderAssignment.count({
      where: {
        memberId: user.id,
        // startDate - 1 day <= date means startDate <= date + 1 day
        startDate: { lte: nextDay },
        endDate: { gte: date },
      },
    });

    if (hutLeaderCount > 0) return "hut-leader";

    // Check staying guest: booking owner or linked member guest where
    // (checkIn - 1 day) <= date <= checkOut.
    const stayingGuestCount = await prisma.booking.count({
      where: {
        status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
        OR: [
          { memberId: user.id },
          {
            guests: {
              some: {
                memberId: user.id,
                stayStart: { lte: nextDay },
                stayEnd: { gte: date },
              },
            },
          },
        ],
        // checkIn - 1 day <= date means checkIn <= date + 1 day
        checkIn: { lte: nextDay },
        // date <= checkOut (using the date itself as the day)
        checkOut: { gte: date },
      },
    });

    if (stayingGuestCount > 0) return "staying-guest";
  }

  return "none";
}

// test seam
/**
 * Returns the date range the user can navigate within on the kiosk,
 * or null for unrestricted (ADMIN/LODGE).
 */
export async function getKioskDateRange(
  user: KioskAccessSubject,
  date?: Date
): Promise<{ minDate: string; maxDate: string } | null> {
  if (hasAdminAccess(user) || hasLodgeAccess(user)) return null;

  const nextDay = date ? addDaysDateOnly(date, 1) : null;

  // Gather all hut leader assignments
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      memberId: user.id,
      ...(date && nextDay
        ? {
            startDate: { lte: nextDay },
            endDate: { gte: date },
          }
        : {}),
    },
    select: { startDate: true, endDate: true },
  });

  // Gather all visible bookings where the signed-in member is staying.
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
      OR: [
        { memberId: user.id },
        {
          guests: {
            some: {
              memberId: user.id,
              ...(date && nextDay
                ? {
                    stayStart: { lte: nextDay },
                    stayEnd: { gte: date },
                  }
                : {}),
            },
          },
        },
      ],
      ...(date && nextDay
        ? {
            checkIn: { lte: nextDay },
            checkOut: { gte: date },
          }
        : {}),
    },
    select: {
      memberId: true,
      checkIn: true,
      checkOut: true,
      guests: {
        where: { memberId: user.id },
        select: {
          stayStart: true,
          stayEnd: true,
        },
      },
    },
  });

  if (assignments.length === 0 && bookings.length === 0) return null;

  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const a of assignments) {
    // Day-before access
    const start = addDaysDateOnly(a.startDate, -1);
    const end = a.endDate;

    if (!minDate || start < minDate) minDate = start;
    if (!maxDate || end > maxDate) maxDate = end;
  }

  for (const b of bookings) {
    const guestRanges =
      b.memberId === user.id
        ? [{ stayStart: b.checkIn, stayEnd: b.checkOut }]
        : (b.guests ?? []);

    for (const range of guestRanges) {
      // Day-before access
      const start = addDaysDateOnly(range.stayStart, -1);
      const end = range.stayEnd;

      if (!minDate || start < minDate) minDate = start;
      if (!maxDate || end > maxDate) maxDate = end;
    }
  }

  if (!minDate || !maxDate) return null;

  return {
    minDate: formatDateOnly(minDate),
    maxDate: formatDateOnly(maxDate),
  };
}

/**
 * Build the full kiosk access response for an API endpoint.
 */
export async function getKioskAccessInfo(
  user: KioskAccessSubject,
  date: Date
): Promise<KioskAccess> {
  const tier = await getKioskAccessTier(user, date);
  const dateRange = await getKioskDateRange(user, date);

  return {
    tier,
    dateRange,
    canManageRoster: tier === "admin" || tier === "hut-leader",
    canMarkAttendance: tier === "admin" || tier === "hut-leader" || tier === "lodge",
    canCompleteChores: tier === "admin" || tier === "hut-leader" || tier === "lodge",
  };
}
