import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
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
    },
    select: {
      memberId: true,
      stayStart: true,
      stayEnd: true,
      member: {
        select: { id: true, firstName: true, lastName: true, email: true, active: true },
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
    },
    select: {
      checkIn: true,
      checkOut: true,
      member: {
        select: { id: true, firstName: true, lastName: true, email: true, active: true, ageTier: true },
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
        bookings: [{ checkIn: b.checkIn, checkOut: b.checkOut }],
      });
    }
  }

  const members = Array.from(memberBookings.values())
    .map((m) => {
      // Find earliest checkIn and latest checkOut as suggested dates
      const earliestCheckIn = m.bookings.reduce((min, b) => b.checkIn < min ? b.checkIn : min, m.bookings[0].checkIn);
      const latestCheckOut = m.bookings.reduce((max, b) => b.checkOut > max ? b.checkOut : max, m.bookings[0].checkOut);

      return {
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        bookingCheckIn: formatDateOnly(earliestCheckIn),
        bookingCheckOut: formatDateOnly(latestCheckOut),
        suggestedStartDate: formatDateOnly(earliestCheckIn),
        suggestedEndDate: formatDateOnly(latestCheckOut),
      };
    })
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  return NextResponse.json({ members });
}
