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
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";

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
        // Other structured rejection codes (e.g. DUPLICATE_STAY): forwarded so
        // the client can distinguish them. Mutually exclusive with the
        // price-drift path above, so there is no code collision.
        ...(result.code ? { code: result.code } : {}),
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
    include: {
      member: true,
      guests: { include: { nights: true } }, // per-night sets (issue #713)
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.PAYMENT_PENDING) {
    // #1881 — flipping a $0 booking PAYMENT_PENDING -> PAID is a net-new
    // capacity claim to a capacity-holding status. confirmWaitlistOffer above
    // committed the PAYMENT_PENDING flip in a SEPARATE transaction under its own
    // per-lodge lock, so this claim ran wholly unserialised before: no lock, no
    // re-check, a bare id-only update. Bring it under the two-tier protocol —
    // global lock(1) first (mutual exclusion with cancel/settlement), then the
    // per-lodge lock (serialise the capacity claim against per-lodge creators),
    // re-read under the locks, re-check capacity, and status-guard the flip.
    const flip = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, booking.lodgeId);

      const locked = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: { include: { nights: true } } },
      });
      if (!locked || locked.status !== BookingStatus.PAYMENT_PENDING) {
        return { ok: false as const, status: 409 };
      }

      const { available } = await checkCapacityForGuestRanges(
        locked.lodgeId,
        locked.checkIn,
        locked.checkOut,
        locked.guests,
        bookingId,
        tx
      );
      if (!available) {
        // PAYMENT_PENDING does not hold capacity. Revert the failed second-stage
        // $0 claim to WAITLISTED inside this locked transaction so ordinary
        // waitlist offering can retry it instead of stranding a booking that
        // owns no bed.
        const restored = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
            waitlistOfferedLodgeId: null,
            waitlistOfferedPriceCents: null,
          },
        });
        if (restored.count === 1) {
          await reconcileBedAllocationsForBooking({
            bookingId,
            db: tx,
            previousRange: {
              checkIn: locked.checkIn,
              checkOut: locked.checkOut,
            },
          });
        }
        return { ok: false as const, status: 409 };
      }

      await tx.payment.create({
        data: {
          bookingId,
          amountCents: 0,
          status: "SUCCEEDED",
        },
      });
      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
        data: { status: BookingStatus.PAID },
      });
      if (claimed.count === 0) {
        // Lost the claim to a concurrent writer despite the lock (defense in
        // depth). The payment.create above rolls back with the transaction.
        return { ok: false as const, status: 409 };
      }
      await reconcileBedAllocationsForBooking({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      return { ok: true as const };
    });

    if (!flip.ok) {
      // The locked claim already restored WAITLISTED, so the normal offer cron
      // can retry it; PAYMENT_PENDING does not hold capacity and is never left
      // parked as an operator-only recovery state.
      return NextResponse.json(
        { error: "Capacity is no longer available for this booking." },
        { status: flip.status }
      );
    }

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
