import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { addDaysDateOnly, formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";

/**
 * GET /api/admin/hut-leaders/eligible-members?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns adult members who have paid/operational bookings overlapping the given date range,
 * along with their booking dates and suggested assignment dates.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: "startDate and endDate are required (YYYY-MM-DD)" }, { status: 400 });
  }

  if (startDate > endDate) {
    return NextResponse.json({ error: "startDate must be before or equal to endDate" }, { status: 400 });
  }
  if (!isDateOnlyString(startDate) || !isDateOnlyString(endDate)) {
    return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
  }

  const rangeStart = parseDateOnly(startDate);
  const rangeEnd = parseDateOnly(endDate);

  // Find adult booking guests whose booking overlaps the date range
  const guests = await prisma.bookingGuest.findMany({
    where: {
      ageTier: "ADULT",
      memberId: { not: null },
      stayStart: { lte: rangeEnd },
      stayEnd: { gt: rangeStart },
      booking: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: rangeEnd },
        checkOut: { gt: rangeStart },
      },
      member: {
        active: true,
        accessRoles: { some: { role: "USER" } },
      },
    },
    select: {
      memberId: true,
      stayStart: true,
      stayEnd: true,
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: true,
        },
      },
      booking: {
        select: { checkIn: true, checkOut: true },
      },
    },
  });

  // Group by memberId, collecting booking dates
  const memberBookings = new Map<string, {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    hutLeaderEligible: boolean;
    hutLeaderEligibleAt: Date | null;
    bookings: { checkIn: Date; checkOut: Date }[];
  }>();

  for (const g of guests) {
    if (!g.memberId || !g.member || !g.member.active) continue;
    const guestStayStart = g.stayStart ?? g.booking.checkIn;
    const guestStayEnd = g.stayEnd ?? g.booking.checkOut;
    const existing = memberBookings.get(g.memberId);
    if (existing) {
      // Avoid duplicate booking entries
      if (!existing.bookings.some((b) => b.checkIn.getTime() === guestStayStart.getTime())) {
        existing.bookings.push({ checkIn: guestStayStart, checkOut: guestStayEnd });
      }
    } else {
      memberBookings.set(g.memberId, {
        id: g.member.id,
        firstName: g.member.firstName,
        lastName: g.member.lastName,
        email: g.member.email,
        hutLeaderEligible: Boolean(g.member.hutLeaderEligible),
        hutLeaderEligibleAt: g.member.hutLeaderEligibleAt ?? null,
        bookings: [{ checkIn: guestStayStart, checkOut: guestStayEnd }],
      });
    }
  }

  // Also include booking owners who are adults
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: rangeEnd },
      checkOut: { gt: rangeStart },
      member: {
        active: true,
        ageTier: "ADULT",
        accessRoles: { some: { role: "USER" } },
      },
    },
    select: {
      checkIn: true,
      checkOut: true,
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          ageTier: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: true,
        },
      },
    },
  });

  for (const b of bookings) {
    if (!b.member.active || b.member.ageTier !== "ADULT") continue;
    const existing = memberBookings.get(b.member.id);
    if (existing) {
      if (!existing.bookings.some((bk) => bk.checkIn.getTime() === b.checkIn.getTime())) {
        existing.bookings.push({ checkIn: b.checkIn, checkOut: b.checkOut });
      }
    } else {
      memberBookings.set(b.member.id, {
        id: b.member.id,
        firstName: b.member.firstName,
        lastName: b.member.lastName,
        email: b.member.email,
        hutLeaderEligible: Boolean(b.member.hutLeaderEligible),
        hutLeaderEligibleAt: b.member.hutLeaderEligibleAt ?? null,
        bookings: [{ checkIn: b.checkIn, checkOut: b.checkOut }],
      });
    }
  }

  // Widen the coverage query window to span every member's actual stay, so an
  // assignment that starts before rangeStart (or ends after rangeEnd) is still
  // considered when deciding which stay nights already have a leader.
  let earliestStayStart = rangeStart;
  let latestStayEnd = rangeEnd;
  let hasAnyBooking = false;
  for (const m of memberBookings.values()) {
    for (const b of m.bookings) {
      if (!hasAnyBooking) {
        earliestStayStart = b.checkIn;
        latestStayEnd = b.checkOut;
        hasAnyBooking = true;
        continue;
      }
      if (b.checkIn.getTime() < earliestStayStart.getTime()) earliestStayStart = b.checkIn;
      if (b.checkOut.getTime() > latestStayEnd.getTime()) latestStayEnd = b.checkOut;
    }
  }

  const coverageWindowStart =
    earliestStayStart.getTime() < rangeStart.getTime() ? earliestStayStart : rangeStart;
  const coverageWindowEnd =
    latestStayEnd.getTime() > rangeEnd.getTime() ? latestStayEnd : rangeEnd;

  // Existing hut-leader assignments overlapping the widened window. We reuse the
  // inclusive covered model from getUnassignedHutLeaderDates (the amber "Upcoming
  // Dates Without…" panel) so suggestions never point at a night that already has
  // a leader. Suggested ranges therefore abut existing assignments (never overlap
  // by more than the 1-day handover boundary the POST route already allows), so
  // they are always safely POST-able.
  const coverageAssignments = await prisma.hutLeaderAssignment.findMany({
    where: { startDate: { lte: coverageWindowEnd }, endDate: { gte: coverageWindowStart } },
    select: { startDate: true, endDate: true },
  });

  // Inclusive covered-night predicate — matches isDateCovered in
  // src/lib/hut-leader-coverage.ts.
  const isNightCovered = (d: Date) =>
    coverageAssignments.some(
      (a) => a.startDate.getTime() <= d.getTime() && a.endDate.getTime() >= d.getTime(),
    );

  const members = Array.from(memberBookings.values())
    .map((m) => {
      // Find earliest checkIn and latest checkOut (the member's overall stay span).
      const earliestCheckIn = m.bookings.reduce((min, b) => b.checkIn < min ? b.checkIn : min, m.bookings[0].checkIn);
      const latestCheckOut = m.bookings.reduce((max, b) => b.checkOut > max ? b.checkOut : max, m.bookings[0].checkOut);

      // Build the set of the member's actual stay nights: the union of the
      // half-open [checkIn, checkOut) day range of each booking. checkOut is the
      // departure morning, NOT an occupied night — this matches every occupancy
      // computation in the repo (getBookingStats / getUnassignedHutLeaderDates,
      // which feed the amber "Upcoming Dates Without…" panel on this same page).
      // Only real stay nights count — gap nights between two disjoint bookings do not.
      const stayNightsByTime = new Map<number, Date>();
      for (const b of m.bookings) {
        for (
          let d = b.checkIn;
          d.getTime() < b.checkOut.getTime();
          d = addDaysDateOnly(d, 1)
        ) {
          stayNightsByTime.set(d.getTime(), d);
        }
      }
      const stayNights = Array.from(stayNightsByTime.values()).sort(
        (a, b) => a.getTime() - b.getTime(),
      );

      const uncoveredNights = stayNights.filter((d) => !isNightCovered(d));
      const uncoveredNightCount = uncoveredNights.length;
      const fullyCovered = uncoveredNightCount === 0;

      // Suggested range = the first contiguous run of uncovered nights. If the
      // member is fully covered, fall back to their overall stay span (fields
      // stay present; the UI disables Confirm for fully-covered members).
      let suggestedStart = earliestCheckIn;
      let suggestedEnd = latestCheckOut;
      if (!fullyCovered) {
        suggestedStart = uncoveredNights[0];
        suggestedEnd = uncoveredNights[0];
        for (let i = 1; i < uncoveredNights.length; i++) {
          if (uncoveredNights[i].getTime() === addDaysDateOnly(suggestedEnd, 1).getTime()) {
            suggestedEnd = uncoveredNights[i];
          } else {
            break;
          }
        }
      }

      return {
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        hutLeaderEligible: m.hutLeaderEligible,
        hutLeaderEligibleAt: m.hutLeaderEligibleAt
          ? m.hutLeaderEligibleAt.toISOString()
          : null,
        bookingCheckIn: formatDateOnly(earliestCheckIn),
        bookingCheckOut: formatDateOnly(latestCheckOut),
        suggestedStartDate: formatDateOnly(suggestedStart),
        suggestedEndDate: formatDateOnly(suggestedEnd),
        uncoveredNightCount,
        fullyCovered,
      };
    })
    .sort(
      (a, b) =>
        Number(a.fullyCovered) - Number(b.fullyCovered) ||
        Number(b.hutLeaderEligible) - Number(a.hutLeaderEligible) ||
        `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
    );

  return NextResponse.json({ members });
}
