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
import { restoreCreditFromBooking } from "@/lib/member-credit";
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
  failed: number;
  bookingIds: string[];
  paymentIds: string[];
}

function releaseOneHold(paymentId: string, now: Date) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.payment.findUnique({
        where: { id: paymentId },
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

      // #1547: a hold-expiry release IS a cancel, and an IB booking can be
      // partly (or fully) credit-covered — booking-create applies credit for
      // every IB shape. Restore it at 100% inside this claim, exactly like the
      // never-captured cancel branch: nothing was captured, so no
      // cancellation-policy tiering. restoreCreditFromBooking has no internal
      // replay guard; this transaction's guard set (payment still PENDING,
      // hold not yet released, booking still CONFIRMED) is its exactly-once
      // guarantee — re-runs skip released holds before reaching this line.
      const creditRestoredCents = await restoreCreditFromBooking(
        fresh.booking.memberId,
        fresh.bookingId,
        tx,
      );

      // Enqueue the invoice-clearing credit note INSIDE the release
      // transaction (#1357, the #1233 in-tx pattern): the outbox row commits
      // atomically with `internetBankingHoldReleasedAt`, so no crash point can
      // strand the open Xero invoice with no self-heal (re-runs skip released
      // holds). The enqueue is a pure local insert — the Xero call happens in
      // the outbox worker, outside this transaction.
      const queued = await enqueueXeroRefundCreditNoteOperation(
        fresh.id,
        fresh.amountCents,
        { store: tx },
      );

      return {
        type: "released" as const,
        payment: fresh,
        creditRestoredCents,
        queueOperationId: queued.queueOperationId,
      };
    },
    // The enqueue adds a handful of reads under the club-wide advisory lock;
    // give the interactive transaction headroom over Prisma's 5s default so
    // lock contention alone cannot abort a release mid-flight.
    { timeout: 15000 },
  );
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
    failed: 0,
    bookingIds: [],
    paymentIds: [],
  };

  for (const candidate of candidates) {
    let transition: Awaited<ReturnType<typeof releaseOneHold>>;
    try {
      transition = await releaseOneHold(candidate.id, now);
    } catch (err) {
      // One poisoned candidate must not starve the rest of the queue: its
      // transaction rolled back whole (hold NOT released, so the next run
      // retries it), and the loop moves on (#1357).
      result.failed += 1;
      logger.error(
        { err, bookingId: candidate.bookingId, paymentId: candidate.id },
        "Failed to release expired Internet Banking hold; will retry next run",
      );
      continue;
    }

    if (transition.type === "skipped") {
      result.skipped += 1;
      continue;
    }

    const { payment, creditRestoredCents } = transition;
    result.released += 1;
    result.bookingIds.push(payment.bookingId);
    result.paymentIds.push(payment.id);

    await recordBookingEvent({
      bookingId: payment.bookingId,
      type: BookingEventType.CANCELLED,
      amountCents: payment.amountCents,
      // #1547: surface the restored applied credit in the narrative, matching
      // the cancel branches.
      reason:
        creditRestoredCents > 0
          ? `Internet Banking payment hold expired before reconciliation. NZ$${(creditRestoredCents / 100).toFixed(2)} of applied account credit was returned.`
          : "Internet Banking payment hold expired before reconciliation.",
      snapshot: {
        paymentId: payment.id,
        holdUntil: payment.internetBankingHoldUntil?.toISOString() ?? null,
        creditRestoredCents,
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
        creditRestoredCents,
      },
    }).catch((err) =>
      logger.error(
        { err, bookingId: payment.bookingId, paymentId: payment.id },
        "Failed to audit expired Internet Banking hold release",
      ),
    );

    // The credit note is already durably enqueued (inside the transaction
    // above); the kick is best-effort — the outbox cron sweeps the row anyway.
    if (transition.queueOperationId) {
      kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
        logger.error(
          { err, bookingId: payment.bookingId, paymentId: payment.id },
          "Failed to kick Xero outbox after expired Internet Banking hold release",
        ),
      );
    }

    sendBookingCancelledEmail(
      payment.booking.member.email,
      payment.booking.member.firstName,
      payment.booking.checkIn,
      payment.booking.checkOut,
      0,
      "credit",
      creditRestoredCents,
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
