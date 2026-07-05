import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

// Matches HH:mm with 30-min increments (00 or 30)
const arrivalTimeSchema = z.object({
  expectedArrivalTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]0$/, "Must be HH:mm with 30-minute increments"),
});

/**
 * PUT /api/bookings/[id]/arrival-time
 * Set or update the expected arrival time on a booking.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { memberId: true, checkIn: true, status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only booking owner or admin can update
  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  // Cannot update after check-in date has passed
  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = arrivalTimeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: parsed.data.expectedArrivalTime },
    select: { id: true, expectedArrivalTime: true },
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/arrival-time
 * Clear the expected arrival time.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { memberId: true, checkIn: true, status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: null },
    select: { id: true, expectedArrivalTime: true },
  });

  return NextResponse.json(updated);
}
