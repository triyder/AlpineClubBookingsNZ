import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadCancellationPolicy } from "@/lib/cancellation";
import { calculateCancellationPreview } from "@/lib/policies/booking-route-decisions";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

/**
 * GET /api/bookings/[id]/cancel-preview
 * Returns the refund breakdown for a booking cancellation without actually cancelling.
 * Used by CancelBookingButton to show amounts before the user confirms.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { payment: true },
    });

    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    // Issue #1313 (option A2): the owner, a Full Admin, or a Booking Officer
    // (bookings:edit) may see the refund breakdown — the read-only companion to
    // the cancel action, gated on the same bookings:edit predicate so a
    // read-only admin (bookings:view) still cannot preview a cancellation.
    if (
      booking.memberId !== session.user.id &&
      !hasAdminAccess(session.user) &&
      !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
      return NextResponse.json(
        { error: "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be cancelled" },
        { status: 400 }
      );
    }

    // PENDING bookings — no payment taken
    if (
      booking.status === "PENDING" ||
      !booking.payment ||
      booking.payment.status !== "SUCCEEDED"
    ) {
      return NextResponse.json({
        refundAmountCents: 0,
        keptAmountCents: 0,
        changeFeeCents: 0,
        refundPercentage: 0,
        creditRefundAmountCents: 0,
        creditRefundPercentage: 0,
        creditRestoredCents: 0,
        totalPaidCents: 0,
        hasPayment: false,
      });
    }

    const policy = await loadCancellationPolicy(booking.checkIn);
    const preview = calculateCancellationPreview({
      payment: booking.payment,
      finalPriceCents: booking.finalPriceCents,
      checkIn: booking.checkIn,
      policyRules: policy,
    });

    return NextResponse.json({
      ...preview,
      hasPayment: true,
    });
  } catch (error) {
    logger.error({ err: error }, "Error generating cancel preview");
    return NextResponse.json(
      { error: "Failed to generate cancellation preview" },
      { status: 500 }
    );
  }
}
