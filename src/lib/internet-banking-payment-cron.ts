import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendBookingCancelledEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";
import { processWaitlistForDates } from "@/lib/waitlist";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

export interface InternetBankingHoldReleaseResult {
  scanned: number;
  released: number;
  skipped: number;
  bookingIds: string[];
  paymentIds: string[];
}

export async function releaseExpiredInternetBankingHolds(
  now = new Date(),
): Promise<InternetBankingHoldReleaseResult> {
  const candidates = await prisma.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      status: PaymentStatus.PENDING,
      internetBankingHoldSlots: true,
      internetBankingHoldUntil: { lte: now },
      internetBankingHoldReleasedAt: null,
    },
    include: {
      booking: {
        include: {
          member: true,
          guests: { include: { nights: true } },
        },
      },
    },
    orderBy: { internetBankingHoldUntil: "asc" },
  });

  const result: InternetBankingHoldReleaseResult = {
    scanned: candidates.length,
    released: 0,
    skipped: 0,
    bookingIds: [],
    paymentIds: [],
  };

  for (const candidate of candidates) {
    const transition = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.payment.findUnique({
        where: { id: candidate.id },
        include: {
          booking: {
            include: {
              member: true,
              guests: { include: { nights: true } },
            },
          },
        },
      });

      if (
        !fresh ||
        fresh.source !== PaymentSource.INTERNET_BANKING ||
        fresh.status !== PaymentStatus.PENDING ||
        !fresh.internetBankingHoldSlots ||
        fresh.internetBankingHoldReleasedAt ||
        !fresh.internetBankingHoldUntil ||
        fresh.internetBankingHoldUntil > now ||
        fresh.booking.status !== BookingStatus.CONFIRMED
      ) {
        return { type: "skipped" as const };
      }

      await tx.booking.update({
        where: { id: fresh.bookingId },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
        },
      });
      await tx.payment.update({
        where: { id: fresh.id },
        data: {
          status: PaymentStatus.FAILED,
          internetBankingHoldReleasedAt: now,
        },
      });
      await revokePaymentLinksForBooking(fresh.bookingId, tx);
      await reconcileBedAllocationsForBooking({
        bookingId: fresh.bookingId,
        db: tx,
      });

      return {
        type: "released" as const,
        payment: fresh,
      };
    });

    if (transition.type === "skipped") {
      result.skipped += 1;
      continue;
    }

    const { payment } = transition;
    result.released += 1;
    result.bookingIds.push(payment.bookingId);
    result.paymentIds.push(payment.id);

    await recordBookingEvent({
      bookingId: payment.bookingId,
      type: BookingEventType.CANCELLED,
      amountCents: payment.amountCents,
      reason: "Internet Banking payment hold expired before reconciliation.",
      snapshot: {
        paymentId: payment.id,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
      },
    });

    createAuditLog({
      action: "booking.internet_banking_hold_expired",
      targetId: payment.bookingId,
      subjectMemberId: payment.booking.memberId,
      entityType: "Booking",
      entityId: payment.bookingId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: "Expired Internet Banking hold released",
      details: JSON.stringify({
        paymentId: payment.id,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        amountCents: payment.amountCents,
      }),
      metadata: {
        paymentId: payment.id,
        paymentSource: PaymentSource.INTERNET_BANKING,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        amountCents: payment.amountCents,
      },
    }).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId, paymentId: payment.id },
        "Failed to audit expired Internet Banking hold release",
      ),
    );

    enqueueXeroRefundCreditNoteOperation(payment.id, payment.amountCents)
      .then((queued) => {
        if (queued.queueOperationId) {
          return kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
        }
        return null;
      })
      .catch((err) =>
        logger.error(
          { err, bookingId: payment.bookingId, paymentId: payment.id },
          "Failed to queue Xero invoice-clearing credit note for expired Internet Banking hold",
        ),
      );

    sendBookingCancelledEmail(
      payment.booking.member.email,
      payment.booking.member.firstName,
      payment.booking.checkIn,
      payment.booking.checkOut,
      0,
      "credit",
    ).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId, paymentId: payment.id },
        "Failed to email member after expired Internet Banking hold release",
      ),
    );

    processWaitlistForDates({
      checkIn: payment.booking.checkIn,
      checkOut: payment.booking.checkOut,
    }).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId },
        "Failed to process waitlist after expired Internet Banking hold release",
      ),
    );
  }

  return result;
}
