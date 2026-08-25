import { NextRequest, NextResponse } from "next/server";
import {
  buildBookingIcs,
  verifyBookingCalendarToken,
} from "@/lib/calendar-links";
import { prisma } from "@/lib/prisma";

// Booking states whose stay no longer stands — the calendar file for one of
// these would put a cancelled or never-held stay in someone's calendar. The
// confirmation email is only sent past these states, so a valid emailed link
// only lands here after the booking was later cancelled or bumped.
const NOT_SERVABLE_STATUSES = new Set([
  "DRAFT",
  "CANCELLED",
  "BUMPED",
  "WAITLISTED",
  "WAITLIST_OFFERED",
]);

/**
 * Sessionless .ics download for one booking's stay (fork issue #35).
 *
 * Linked from the booking-confirmed email's `{{ical}}` block, so it must work
 * without a signed-in session: the `token` query parameter is an HMAC of the
 * booking id under the app auth secret (see calendar-links.ts). A valid token
 * reads exactly one booking's stay dates and lodge name; anything invalid is
 * an indistinguishable 404.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get("token");
  if (!id || !token || !verifyBookingCalendarToken(id, token)) {
    return new NextResponse(null, { status: 404 });
  }

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      checkIn: true,
      checkOut: true,
      status: true,
      deletedAt: true,
      lodge: { select: { name: true } },
    },
  });
  if (!booking || booking.deletedAt || NOT_SERVABLE_STATUSES.has(booking.status)) {
    return new NextResponse(null, { status: 404 });
  }

  const ics = buildBookingIcs({
    stay: { bookingId: id, checkIn: booking.checkIn, checkOut: booking.checkOut },
    lodgeName: booking.lodge.name,
    generatedAt: new Date(),
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="lodge-stay.ics"',
      "Cache-Control": "private, no-store",
    },
  });
}
