import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { confirmWaitlistOffer } from "@/lib/waitlist";
import {
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
} from "@/lib/email";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  const result = await confirmWaitlistOffer(bookingId, session.user.id);

  if (!result.success) {
    const status = result.error === "Forbidden" ? 403
      : result.error === "Booking not found" ? 404
      : 400;
    return NextResponse.json(
      {
        error: result.error,
        // Price drift on a cross-lodge offer (ADR-004): the client shows
        // the refreshed figure so the member can re-confirm knowingly.
        ...(result.updatedPriceCents !== undefined
          ? { updatedPriceCents: result.updatedPriceCents, code: "OFFER_PRICE_CHANGED" }
          : {}),
      },
      { status },
    );
  }

  // Cross-lodge accept (ADR-004): the entry was replaced by a fresh booking
  // at the offered lodge. The standard creation path already handled
  // payment status, emails, and zero-dollar logic for the new booking, so
  // just point the client at it.
  if (result.newBookingId) {
    const newBooking = await prisma.booking.findUnique({
      where: { id: result.newBookingId },
      select: { finalPriceCents: true, status: true },
    });
    return NextResponse.json({
      success: true,
      status: result.newStatus,
      newBookingId: result.newBookingId,
      requiresPayment:
        result.newStatus === BookingStatus.PAYMENT_PENDING &&
        (newBooking?.finalPriceCents ?? 0) > 0,
      requiresSetup: result.newStatus === BookingStatus.PENDING,
    });
  }

  // Handle zero-dollar bookings — auto-create payment and set PAID
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.PAYMENT_PENDING) {
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          bookingId,
          amountCents: 0,
          status: "SUCCEEDED",
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.PAID },
      });
      await reconcileBedAllocationsForBooking({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
    });

    sendBookingConfirmedEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
      {
        lodgeId: booking.lodgeId,
        ...(booking.promoRedemption?.promoCode
          ? {
              discountCents: booking.discountCents,
              promoAdjustmentCents: booking.promoAdjustmentCents,
              promoCode: booking.promoRedemption.promoCode.code,
            }
          : {}),
      }
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send confirmation email after waitlist confirm"));

    void enqueueXeroBookingInvoiceOperation(bookingId)
      .then(async (queuedInvoice) => {
        if (!queuedInvoice.queueOperationId) {
          return;
        }

        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      })
      .catch((err) =>
        logger.error(
          { err, bookingId },
          "Failed to queue Xero invoice after waitlist confirm"
        )
      );

    return NextResponse.json({
      success: true,
      status: "PAID",
      requiresPayment: false,
    });
  }

  // For PENDING bookings, send pending email
  if (result.newStatus === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
    sendBookingPendingEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.nonMemberHoldUntil,
      booking.lodgeId
    ).catch((err) => logger.error({ err }, "Failed to send pending email after waitlist confirm"));
  }

  return NextResponse.json({
    success: true,
    status: result.newStatus,
    requiresPayment: result.newStatus === BookingStatus.PAYMENT_PENDING && booking.finalPriceCents > 0,
    requiresSetup: result.newStatus === BookingStatus.PENDING,
  });
}
