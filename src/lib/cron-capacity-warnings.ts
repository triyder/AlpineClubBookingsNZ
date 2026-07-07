import { prisma } from "./prisma";
import { sendAdminCapacityWarningAlert } from "./email";
import { getOccupiedBedsForNight } from "./capacity";
import { getLodgeCapacity } from "./lodge-capacity";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { getNZSTToday } from "./nzst-date";
import { eachDayOfInterval, addDays } from "date-fns";
import logger from "@/lib/logger";
import { capacityHoldingBookingFilter } from "@/lib/booking-status";

const WARN_THRESHOLD_BEDS = 5; // Alert when <= 5 beds remaining

/**
 * N-03: Check capacity for the next 14 days and alert admins
 * about high-occupancy days.
 * Runs daily at 7:00 AM NZST.
 *
 * Per lodge (lodge-scoping contract): each active lodge's occupancy is
 * compared against that lodge's own capacity — occupied beds are never
 * summed across lodges — and each lodge with warning days gets its own
 * alert naming the lodge (name shown only when a second active lodge
 * exists, ADR-002). Lodges resolving to capacity 0 (unconfigured) are
 * skipped: they cannot be overbooked and would otherwise alarm daily.
 */
export async function checkCapacityWarnings(): Promise<{ alertedDays: number }> {
  const todayNZ = getNZSTToday();
  const endDate = addDays(todayNZ, 14);

  const nights = eachDayOfInterval({
    start: todayNZ,
    end: addDays(endDate, -1),
  });

  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const showLodgeName = activeLodges.length > 1;

  let alertedDays = 0;

  for (const lodge of activeLodges) {
    const lodgeCapacity = await getLodgeCapacity(lodge.id);
    if (lodgeCapacity <= 0) continue;

    // Overlapping bookings at this lodge only. Booking.lodgeId is NOT NULL
    // (migration 20260708001100), so lodgeNullTolerantScope is a strict
    // per-lodge match — no null-lodge rows to count against every lodge.
    const overlappingBookings = await prisma.booking.findMany({
      where: {
        checkIn: { lt: endDate },
        checkOut: { gt: todayNZ },
        // Capacity-holding population (issue #1254); per-lodge scope under AND
        // so the two OR fragments compose rather than clobber.
        ...capacityHoldingBookingFilter(),
        AND: [lodgeNullTolerantScope(lodge.id)],
      },
      include: { guests: true },
    });

    const highOccupancyDays: Array<{
      date: Date;
      occupiedBeds: number;
      availableBeds: number;
    }> = [];

    for (const night of nights) {
      const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

      const availableBeds = lodgeCapacity - occupiedBeds;
      if (availableBeds <= WARN_THRESHOLD_BEDS) {
        highOccupancyDays.push({ date: night, occupiedBeds, availableBeds });
      }
    }

    if (highOccupancyDays.length === 0) continue;

    try {
      await sendAdminCapacityWarningAlert(
        highOccupancyDays,
        lodgeCapacity,
        showLodgeName ? lodge.name : null,
      );
      alertedDays += highOccupancyDays.length;
    } catch (err) {
      logger.error(
        { err, lodgeId: lodge.id },
        "Failed to send capacity warning admin alert",
      );
    }
  }

  return { alertedDays };
}
