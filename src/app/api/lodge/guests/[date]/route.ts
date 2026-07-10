import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import {
  addDaysDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { formatXeroPhone } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { isCheckinBlockedByPendingReview } from "@/lib/booking-review";
import {
  getGuestStayEnd,
  getGuestStayStart,
  getLodgeVisibleGuestsForDate,
} from "@/lib/booking-guest-stay-ranges";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LODGE_LIST_SCOPE = "lodge-list";

/**
 * GET /api/lodge/guests/[date]
 * Returns the lodge list for a date: all confirmed guests grouped by booking,
 * with arriving/departing indicators and expected arrival times.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
    allowPreview: true,
  });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const nextDay = addDaysDateOnly(date, 1);
  const scope = new URL(req.url).searchParams.get("scope");
  const isLodgeListScope = scope === LODGE_LIST_SCOPE;
  const canViewGuestContactDetails = tier !== "staying-guest";
  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }

  // Default scope is stay-night compatible for roster allocation.
  // Lodge-list scope also includes guests on their checkout/departure date.
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: date },
      checkOut: isLodgeListScope ? { gte: date } : { gt: date },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: date },
          stayEnd: isLodgeListScope ? { gte: date } : { gt: date },
        },
      },
      // #1422: the guest list (the check-in roster staff read) INCLUDES a
      // booking blocked by a pending admin review so staff can see who is
      // blocked. It is flagged per-booking below via `blockedFromCheckin` and
      // its arrival toggle is disabled in the kiosk. The mutation/enforcement
      // paths (arrive/depart/roster-confirm in lodge-date-scoping.ts) keep
      // excluding it, so a blocked guest still cannot be marked arrived
      // server-side (defense in depth).
    },
    include: {
      guests: {
        where: {
          stayStart: { lte: date },
          stayEnd: isLodgeListScope ? { gte: date } : { gt: date },
        },
        include: {
          member: {
            select: {
              ageTier: true,
              phoneCountryCode: true,
              phoneAreaCode: true,
              phoneNumber: true,
            },
          },
        },
      },
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { checkIn: "asc" },
  });

  const result = bookings
    .map((b) => {
      const visibleGuests = getLodgeVisibleGuestsForDate(b.guests, date, b, {
        includeDepartureDate: isLodgeListScope,
      });

      return {
        bookingId: b.id,
        memberName: `${b.member.firstName} ${b.member.lastName}`,
        expectedArrivalTime: b.expectedArrivalTime,
        // #1422: flag (don't hide) a booking blocked by a pending admin review.
        // The kiosk shows a "see Booking Officer" note and disables its arrival
        // toggle; the arrive/depart endpoints still reject it server-side.
        blockedFromCheckin: isCheckinBlockedByPendingReview(b),
        guests: visibleGuests.map((g) => {
          const ageTier = getBookingGuestDisplayAgeTier(g);
          const stayStart = getGuestStayStart(g, b);
          const stayEnd = getGuestStayEnd(g, b);

          return {
            id: g.id,
            firstName: g.firstName,
            lastName: g.lastName,
            ageTier,
            isMember: g.isMember,
            isArriving: stayStart.getTime() === date.getTime(),
            isDeparting: isLodgeListScope
              ? stayEnd.getTime() === date.getTime()
              : stayEnd.getTime() === nextDay.getTime(),
            arrivedAt: g.arrivedAt?.toISOString() ?? null,
            departedAt: g.departedAt?.toISOString() ?? null,
            phone:
              canViewGuestContactDetails && ageTier === "ADULT" && g.member
                ? formatXeroPhone(g.member)
                : null,
          };
        }),
      };
    })
    .filter((booking) => booking.guests.length > 0);

  return NextResponse.json({
    date: dateStr,
    tier,
    bookings: result,
    totalGuests: result.reduce((sum, b) => sum + b.guests.length, 0),
  });
}
