import { prisma } from "./prisma";
import { cancelPaymentIntentIfCancellable, cancelSetupIntentIfCancellable } from "./stripe";
import { isXeroConnected } from "./xero";
import {
  calculateAppliedCreditRestore,
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { sendBookingCancelledEmail } from "./email";
import { logAudit } from "./audit";
import { recordBookingEvent } from "./booking-events";
import { BookingEventType } from "@prisma/client";
import { createCancellationCredit, restoreCreditFromBooking } from "./member-credit";
import { processWaitlistForDates } from "./waitlist";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import logger from "@/lib/logger";
import {
  applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
  PartialRefundError,
} from "@/lib/payment-transactions";
import { enqueueBookingCancellationRefundRecovery } from "@/lib/payment-recovery";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";
import { settleGroupBookingOnOrganiserCancel } from "@/lib/group-cancel";

// Statuses a booking may be cancelled from. Shared by the outer validation
// guard and the tx1 single-flight re-check so the two can never drift (#1160).
const CANCELLABLE_BOOKING_STATUSES: readonly string[] = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "AWAITING_REVIEW",
];

// The no-payment / holding statuses the shared cancel path may flip straight to
// CANCELLED with no refund and no external-provider (Stripe/Xero) work. A strict
// subset of CANCELLABLE_BOOKING_STATUSES. This is the exact WHERE set for the
// #1311 status-guarded claim-first: a booking that has left this set under the
// advisory lock (e.g. a concurrent quote-accept converting AWAITING_REVIEW ->
// PENDING) must NOT be clobbered to CANCELLED.
const NO_PAYMENT_CANCELLABLE_STATUSES: readonly string[] = [
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "AWAITING_REVIEW",
];

interface CancelBookingResult {
  success: boolean;
  refundAmountCents: number;
  refundPercentage: number;
  refundMethod: "card" | "credit";
  creditAmountCents?: number;
  creditRestoredCents?: number;
  stripeRefundId?: string;
  message: string;
}

async function reconcileCancelledBookingBedAllocations(
  booking: { id: string; checkIn: Date; checkOut: Date },
  db: Parameters<typeof reconcileBedAllocationsForBooking>[0]["db"] = prisma,
) {
  await reconcileBedAllocationsForBooking({
    bookingId: booking.id,
    db,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });
}

type CancelBookingResponse =
  | { status: 401; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 400; error: string }
  | { status: 409; error: string }
  | { status: 200; data: CancelBookingResult };

/**
 * Shared cancellation service used by both cancel routes.
 *
 * Split bookings (#738): cancelling the member (parent) booking also cancels
 * its linked provisional non-member child (PENDING, holds nothing, no payment),
 * so a family is cancelled as one. Cancelling the non-member child on its own
 * leaves the member booking intact.
 *
 * `options.suppressCustomerNotification` (#1255): when `true`, skip the
 * customer-facing "booking cancelled" email. Currently honored on the
 * no-payment / AWAITING_REVIEW cancellation path only — used by the admin
 * "Release hold" action, which cancels a held (AWAITING_REVIEW) booking to
 * re-open owner mapping without telling the requester their reservation was
 * cancelled. Refund-path notifications are unaffected. Defaults to `false`, so
 * every existing caller is unchanged.
 */
export async function cancelBooking(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string,
  refundMethod: "card" | "credit" = "card",
  options: { suppressCustomerNotification?: boolean } = {}
): Promise<CancelBookingResponse> {
  const result = await performBookingCancellation(
    bookingId,
    sessionUserId,
    sessionUserRole,
    ipAddress,
    refundMethod,
    options.suppressCustomerNotification ?? false
  );

  if (result.status === 200) {
    await cancelLinkedProvisionalChildBookings(bookingId, sessionUserId, ipAddress);
    // If this booking hosts a group, clean up the joiners the PENDING-only sweep
    // above never touches (ORGANISER_PAYS children, group closure). Best-effort:
    // the organiser's own cancel has already committed, so a failure here is
    // logged rather than surfaced, and the work is idempotent. A re-invoked
    // cancel 409s upstream (#1160) and never re-enters this path, so a crash
    // mid-cleanup is re-driven by the group-settlement-reaper resume phase
    // (#1236), not by cancelling again.
    await settleGroupBookingOnOrganiserCancel(
      bookingId,
      sessionUserId,
      ipAddress
    ).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to clean up group booking on organiser cancel"
      )
    );
  }

  return result;
}

/**
 * Cancel any provisional non-member child bookings linked to a cancelled
 * member booking. Children are always PENDING (uncharged) so this mirrors the
 * no-payment cancel path: status flip, bed-allocation reconcile, promo cleanup,
 * payment-link revocation, audit and a cancellation email.
 */
async function cancelLinkedProvisionalChildBookings(
  parentBookingId: string,
  sessionUserId: string,
  ipAddress: string
) {
  const children = await prisma.booking.findMany({
    where: {
      parentBookingId,
      status: "PENDING",
      deletedAt: null,
    },
    include: { member: true },
  });

  for (const child of children) {
    await prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: child.id },
        data: { status: "CANCELLED" },
      });
      await reconcileCancelledBookingBedAllocations(child, tx);
      await revokePaymentLinksForBooking(child.id, tx);
    });
    await cleanupPromoRedemption(child.id);

    logBookingCancellationAudit({
      booking: child,
      bookingId: child.id,
      sessionUserId,
      details:
        "Linked provisional non-member booking cancelled with its member booking",
      ipAddress,
      metadata: { linkedParentBookingId: parentBookingId, paymentTaken: false },
    });

    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: "Cancelled with the linked member booking. No payment was taken.",
    });

    sendBookingCancelledEmail(
      child.member.email,
      child.member.firstName,
      child.checkIn,
      child.checkOut,
      0
    ).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to send cancellation email for linked provisional booking"
      )
    );

    processWaitlistForDates({ checkIn: child.checkIn, checkOut: child.checkOut }).catch(
      (err) =>
        logger.error(
          { err, bookingId: child.id },
          "Failed to process waitlist after linked provisional cancellation"
        )
    );
  }
}

async function performBookingCancellation(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string,
  refundMethod: "card" | "credit" = "card",
  suppressCustomerNotification = false
): Promise<CancelBookingResponse> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return { status: 404, error: "Booking not found" };
  }

  if (booking.memberId !== sessionUserId && sessionUserRole !== "ADMIN") {
    return { status: 403, error: "Forbidden" };
  }

  if (!CANCELLABLE_BOOKING_STATUSES.includes(booking.status)) {
    return {
      status: 400,
      error: "Only PENDING, PAYMENT_PENDING, CONFIRMED, PAID, WAITLISTED, WAITLIST_OFFERED, or AWAITING_REVIEW bookings can be cancelled",
    };
  }

  // Bookings awaiting admin review have no payment yet; same no-payment
  // shape as waitlisted/offered. Reuse that path.
  if (NO_PAYMENT_CANCELLABLE_STATUSES.includes(booking.status)) {
    // ── #1311: status-guarded claim-first under the booking advisory lock ──
    //
    // This branch has NO payment and makes NO external-provider (Stripe/Xero)
    // call, so the only hazard is a state CLOBBER, not a double money-move —
    // the "claim-first without durable recovery inverts a crash into money
    // LOSS" caveat does not apply here. The clobber: a held AWAITING_REVIEW
    // booking can be converted to PENDING by a concurrent quote-accept
    // (`convertBookingRequestToBooking` in booking-request.ts). That accept
    // takes `pg_advisory_xact_lock(1)`, re-reads the held booking's status
    // under the lock (booking-request.ts:903), and — if still AWAITING_REVIEW
    // — updates it by id ONLY, with no status guard (booking-request.ts:951).
    // A plain, lockless `booking.update` here could be sequenced between that
    // accept's status re-read and its id-only write, clobbering the
    // just-accepted PENDING booking back to CANCELLED (a guarded updateMany
    // WITHOUT the lock does NOT close this, because the accept's id-only write
    // would overwrite the CANCELLED it committed). Taking the SAME advisory
    // lock and re-reading the status under it makes cancel and accept mutually
    // exclude; the race loser observes a non-cancellable status and aborts
    // cleanly with a 409, running none of the side effects below. This mirrors
    // the paid single-flight claim (#1160) further down.
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      // Race loser / retry: under the lock the booking has left the no-payment
      // set (a concurrent quote-accept converted it, or another cancel already
      // claimed it). Do NOT flip status, detach, reconcile, or run any side
      // effects.
      if (!fresh || !NO_PAYMENT_CANCELLABLE_STATUSES.includes(fresh.status)) {
        return { claimed: false as const };
      }

      const wasOffered = fresh.status === "WAITLIST_OFFERED";
      const wasAwaitingReview = fresh.status === "AWAITING_REVIEW";

      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: "CANCELLED",
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistPosition: null,
        },
      });
      if (wasAwaitingReview) {
        // Detach any booking-request pointer to this hold so a later re-quote
        // creates a fresh hold instead of reusing this now-cancelled row
        // (#1254 stale-pointer fix). holdBookingRequestSlots also re-validates
        // defensively, but detaching at the source keeps the pointer honest.
        await tx.bookingRequest.updateMany({
          where: { heldBookingId: bookingId },
          data: { heldBookingId: null },
        });
      }
      // Bed release is now ATOMIC with the status flip under the lock.
      await reconcileCancelledBookingBedAllocations(booking, tx);

      return {
        claimed: true as const,
        wasOffered,
        wasAwaitingReview,
        priorStatus: fresh.status,
      };
    });

    // Loser contract (mirrors the paid single-flight path, #1160): a concurrent
    // quote-accept / cancel that transitioned the row out of the no-payment set
    // gets a real 409. This MUST be non-200 so a caller never treats a clobbered
    // accept as a successful cancel. Every cancelBooking caller forwards this
    // 409 (release-hold, member cancel, admin review-reject) or aborts safely
    // (deletion-requests, which never passes a no-payment-holding status).
    if (!claim.claimed) {
      return {
        status: 409,
        error:
          "This booking was concurrently accepted or cancelled and can no longer be cancelled",
      };
    }

    const { wasOffered, wasAwaitingReview, priorStatus } = claim;

    // cleanupPromoRedemption opens its own $transaction, so it runs AFTER the
    // claim commits — never nested under the advisory lock.
    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: wasAwaitingReview
        ? "Booking awaiting admin review cancelled"
        : `Waitlisted booking cancelled (was ${wasOffered ? "WAITLIST_OFFERED" : "WAITLISTED"})`,
      ipAddress,
      metadata: { wasOffered, priorStatus },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: wasAwaitingReview
        ? "Cancelled while awaiting admin review. No payment was taken."
        : "Cancelled before payment. No payment was taken.",
    });

    // #1255: the admin "Release hold" action cancels this held booking to
    // re-open owner mapping and passes suppressCustomerNotification, so the
    // requester is not emailed a cancellation for a hold being administratively
    // released. The detach/reconcile/audit above still run.
    if (!suppressCustomerNotification) {
      sendBookingCancelledEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        0,
        "card"
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email for no-payment booking"));
    }

    // If the booking was WAITLIST_OFFERED, re-process waitlist for these dates
    if (wasOffered) {
      processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
        .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after offer cancellation"));
    }

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card" as const,
        message: wasAwaitingReview
          ? "Booking awaiting review cancelled successfully"
          : "Waitlisted booking cancelled successfully",
      },
    };
  }

  // Handle PENDING bookings (no payment taken yet)
  if (booking.status === "PENDING") {
    if (booking.payment?.stripeSetupIntentId) {
      try {
        await cancelSetupIntentIfCancellable(booking.payment.stripeSetupIntentId);
      } catch (err) {
        logger.error(
          { err, bookingId, setupIntentId: booking.payment.stripeSetupIntentId },
          "Failed to cancel Stripe SetupIntent for cancelled pending booking"
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      if (booking.payment) {
        await tx.payment.update({
          where: { id: booking.payment.id },
          data: { stripeSetupIntentId: null },
        });
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });
      await reconcileCancelledBookingBedAllocations(booking, tx);
      await revokePaymentLinksForBooking(bookingId, tx);
    });
    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: "Pending booking cancelled, no payment taken",
      ipAddress,
      metadata: {
        paymentTaken: false,
        setupIntentCancelled: Boolean(booking.payment?.stripeSetupIntentId),
      },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: "Cancelled before payment. No payment was taken.",
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after pending cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        message: "Pending booking cancelled. No payment was taken.",
      },
    };
  }

  // Handle PAYMENT_PENDING/CONFIRMED/PAID bookings without successful payment
  if (!booking.payment || booking.payment.status !== "SUCCEEDED") {
    if (booking.payment) {
      await cancelOutstandingPaymentIntents({
        primaryPaymentIntentId: booking.payment.stripePaymentIntentId,
        additionalPaymentIntentId: booking.payment.additionalPaymentIntentId,
        cancelPrimary: true,
        cancelAdditional: hasOutstandingAdditionalPaymentIntent(booking.payment),
      });
    }

    const paymentUpdateData: {
      status: "FAILED";
      additionalPaymentStatus?: string;
    } = {
      status: "FAILED",
    };

    if (hasOutstandingAdditionalPaymentIntent(booking.payment)) {
      paymentUpdateData.additionalPaymentStatus = "FAILED";
    }

    if (booking.payment) {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: booking.payment.id },
          data: paymentUpdateData,
        }),
        prisma.booking.update({
          where: { id: bookingId },
          data: { status: "CANCELLED" },
        }),
      ]);
      await reconcileCancelledBookingBedAllocations(booking);
    } else {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });
      await reconcileCancelledBookingBedAllocations(booking);
    }
    await cleanupPromoRedemption(bookingId);

    // Clear the outstanding balance on an unpaid issued invoice. The true
    // amount owed is the current finalPrice plus any billed change fee: a
    // prior reduction issues a modification credit note against the primary
    // invoice but never reissues it, so the invoice's outstanding balance is
    // originalTotal minus those credit notes = finalPrice. Reading
    // `amountCents - refundedAmountCents` instead over-credits during the
    // window before async Xero reconciliation folds the modification credit
    // note into refundedAmountCents (the mirror stays at the original total),
    // issuing a clearing credit note larger than the invoice (#1015). The old
    // `Math.max` only ever picked that stale term in exactly that leak window;
    // for price increases (billed via a separate supplementary invoice) and
    // for unchanged bookings finalPrice already equals the true outstanding.
    const xeroClearingAmountCents = booking.payment?.xeroInvoiceId
      ? booking.finalPriceCents + booking.payment.changeFeeCents
      : 0;

    if (booking.payment?.id && xeroClearingAmountCents > 0) {
      try {
        const queuedCreditNote = await enqueueXeroModificationCreditNoteOperation(
          {
            bookingId,
            refundAmountCents: xeroClearingAmountCents,
          },
          {
            createdByMemberId: sessionUserId,
          }
        );

        if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
          void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
            logger.error(
              { err: xeroErr, bookingId, paymentId: booking.payment?.id },
              "Failed to kick Xero invoice-clearing credit note outbox worker"
            );
          });
        }
      } catch (xeroErr) {
        logger.error(
          {
            err: xeroErr,
            bookingId,
            paymentId: booking.payment.id,
            xeroClearingAmountCents,
          },
          "Failed to queue Xero invoice-clearing credit note for cancelled unpaid booking"
        );
      }
    }

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details:
        xeroClearingAmountCents > 0
          ? `Confirmed booking cancelled before payment capture; queued Xero credit note for ${xeroClearingAmountCents} cents to clear the outstanding invoice`
          : "Confirmed booking cancelled, no payment to refund",
      ipAddress,
      metadata: {
        paymentTaken: false,
        xeroClearingAmountCents,
        queuedXeroClearingCreditNote: xeroClearingAmountCents > 0,
      },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: "Cancelled before payment was captured. Nothing was charged.",
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after confirmed cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        message:
          xeroClearingAmountCents > 0
            ? "Booking cancelled. Any outstanding Xero invoice balance is being cleared."
            : "Booking cancelled. No refund applicable.",
      },
    };
  }

  // ── PAID PATH: single-flight claim-first (#1160) ──────────────────
  //
  // Phase 1 (tx1) is a DB-only critical section under the global booking
  // advisory lock. It re-reads the booking under the lock, freezes the refund
  // plan from that locked read, flips status to CANCELLED, and — for the
  // credit path — writes the refund-allocation + credit ledger entries
  // atomically with that flip. NO Stripe/Xero calls happen inside tx1.
  //
  // The atomic status flip is the single-flight CLAIM and the only
  // idempotency guarantee this path needs. The credit writers
  // (restoreCreditFromBooking / applyLocalRefundAllocation /
  // createCancellationCredit) run exactly once per successful claim; a retry
  // or a concurrent cancel re-reads a non-cancellable/non-paid booking here
  // (or trips the pre-existing status-400 guard above) and returns 409 without
  // moving any money. That is why we deliberately do NOT add
  // description-string idempotency guards to the credit writers: restore and
  // cancellation-credit both legitimately write
  // CANCELLATION_REFUND/sourceBookingId for one booking, so no
  // (sourceBookingId,type) unique key is possible, and a description match
  // would be fragile in money code.
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const fresh = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, member: true },
    });

    // Single-flight gate: the race loser / a retry lands here.
    if (
      !fresh ||
      !CANCELLABLE_BOOKING_STATUSES.includes(fresh.status) ||
      !fresh.payment ||
      fresh.payment.status !== "SUCCEEDED"
    ) {
      return { claimed: false as const };
    }
    const payment = fresh.payment;

    // Freeze the refund plan from the LOCKED read. Change fees (from prior
    // booking modifications) are non-refundable per FEE-03. The refundable
    // base is capped at the booking's current value (#1031): a stale Payment
    // mirror (credit-settled reductions, IB invoices paid at a reduced amount,
    // penalty-window retentions) would otherwise pay out more than the booking
    // is worth. Paid-path twin of the #1015/#1029 unpaid-invoice clearing rule.
    // Computed BEFORE the credit restore so the applied-credit slice can be
    // tiered off the same base/tier as the card slice (#1164 / D7).
    const paidAmountCents = payment.amountCents - payment.refundedAmountCents;
    const refundableBaseCents =
      Math.min(paidAmountCents, fresh.finalPriceCents + payment.changeFeeCents) -
      payment.changeFeeCents;
    const days = daysUntilDate(fresh.checkIn);
    const policy = await loadCancellationPolicy(fresh.checkIn);

    // Idempotent-by-claim credit restore: only reached once per claim. The
    // applied-credit slice is now tiered by the SAME card tier as the card
    // slice (#1164 / D7) rather than restored at 100%. Tier off the mirror
    // payment.creditAppliedCents (NOT the ledger sum) so the actual restore
    // matches the preview input; restoreCreditFromBooking caps the override at
    // the ledger sum in the SAFE (never over-restore) direction.
    let creditRestoredCents = 0;
    if (payment.creditAppliedCents > 0) {
      const { creditRestoredCents: creditToRestore } = calculateAppliedCreditRestore(
        payment.creditAppliedCents,
        refundableBaseCents,
        days,
        policy,
      );
      creditRestoredCents = await restoreCreditFromBooking(
        fresh.memberId,
        bookingId,
        tx,
        creditToRestore,
      );
    }

    const { refundAmountCents, refundPercentage } = calculateRefundAmount(
      refundableBaseCents,
      days,
      policy,
      refundMethod
    );
    const shouldFailAdditionalPayment =
      hasOutstandingAdditionalPaymentIntent(payment);

    // CLAIM: the atomic single-flight commit.
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });

    // Fail the additional-payment DB state in-tx; the Stripe cancellation of
    // the additional intent is external and runs best-effort in Phase 2.
    if (shouldFailAdditionalPayment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { additionalPaymentStatus: "FAILED" },
      });
      if (payment.additionalPaymentIntentId) {
        await markPaymentIntentTransactionFailed({
          paymentIntentId: payment.additionalPaymentIntentId,
          store: tx,
        });
      }
    }

    await reconcileCancelledBookingBedAllocations(fresh, tx);

    // Credit-path ledger writes, ATOMIC with the claim (fixes hazard #3):
    // consumed refundable value and the credit entry commit together with the
    // status flip, so a crash can never leave one without the other.
    if (refundMethod === "credit" && refundAmountCents > 0) {
      await applyLocalRefundAllocation({
        paymentId: payment.id,
        amountCents: refundAmountCents,
        store: tx,
      });
      await createCancellationCredit(
        fresh.memberId,
        refundAmountCents,
        bookingId,
        undefined,
        tx
      );
    }

    return {
      claimed: true as const,
      fresh,
      payment,
      creditRestoredCents,
      refundAmountCents,
      refundPercentage,
      refundableBaseCents,
      paidAmountCents,
      days,
      shouldFailAdditionalPayment,
    };
  });

  // Loser contract: a concurrent cancel / retry that failed to claim gets a
  // real 409. This MUST be non-200 so the outer cancelBooking does not re-run
  // the group/child cleanup and does not report a false refundAmountCents:0.
  if (!claim.claimed) {
    return {
      status: 409,
      error: "This booking is already being cancelled or has been cancelled",
    };
  }

  const {
    fresh,
    payment,
    creditRestoredCents,
    refundAmountCents,
    refundPercentage,
    refundableBaseCents,
    paidAmountCents,
    days,
    shouldFailAdditionalPayment,
  } = claim;
  const paymentId = payment.id;

  if (creditRestoredCents > 0) {
    logger.info(
      { bookingId, creditRestoredCents },
      "Restored previously applied credit on cancellation"
    );
  }

  // ── Phase 2 — external work, AFTER tx1 committed ──────────────────
  // The claim already stands; no failure below may abort it.

  // Additional-payment-intent Stripe cancel (best-effort). The DB state was
  // already flipped to FAILED in tx1; a Stripe cancel failure here is logged,
  // not rethrown (behaviour change vs pre-#1160, which re-threw and aborted
  // the whole cancel).
  if (shouldFailAdditionalPayment) {
    try {
      await cancelOutstandingPaymentIntents({
        primaryPaymentIntentId: null,
        additionalPaymentIntentId: payment.additionalPaymentIntentId,
        cancelPrimary: false,
        cancelAdditional: true,
      });
    } catch (err) {
      logger.error(
        {
          err,
          bookingId,
          additionalPaymentIntentId: payment.additionalPaymentIntentId,
        },
        "Failed to cancel additional payment intent after cancellation claim committed"
      );
    }
  }

  // ── Credit branch: ledger writes already happened in tx1 ──────────
  if (refundMethod === "credit" && refundAmountCents > 0) {
    try {
      const queuedCreditNote = await enqueueXeroAccountCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero account-credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue unapplied Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: payment.changeFeeCents > 0
        ? `Credit ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents as account credit`
        : `Credit ${refundPercentage}% = ${refundAmountCents} cents as account credit`,
      ipAddress,
      metadata: {
        refundMethod: "credit",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: payment.changeFeeCents,
        creditRestoredCents,
      },
    });

    // CANCELLED (post-payment) — the CREDITED settlement event is written by
    // createCancellationCredit (member-credit.ts) inside tx1.
    await recordCancellationEvent({
      bookingId,
      actorMemberId: sessionUserId,
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% credit refund under the policy in effect at the time.`,
      refundMethod: "credit",
      refundPercentage,
      paidAmountCents,
      settledAmountCents: refundAmountCents,
      changeFeeCents: payment.changeFeeCents,
    });

    sendBookingCancelledEmail(
      fresh.member.email,
      fresh.member.firstName,
      fresh.checkIn,
      fresh.checkOut,
      refundAmountCents,
      "credit",
      creditRestoredCents
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after credit cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "credit",
        creditAmountCents: refundAmountCents,
        creditRestoredCents: creditRestoredCents || undefined,
        message: `Booking cancelled. ${refundPercentage}% credit of $${(refundAmountCents / 100).toFixed(2)} added to your account.`,
      },
    };
  }

  // ── Card branch: Stripe refund ────────────────────────────────────
  if (refundAmountCents > 0) {
    let stripeRefundId: string | undefined;
    try {
      const refundResult = await refundPaymentTransactions({
        paymentId,
        amountCents: refundAmountCents,
        metadata: {
          bookingId,
          reason: "cancellation",
          refundPercentage: refundPercentage.toString(),
        },
        idempotencyKeyPrefix: `booking_cancel_refund_${bookingId}`,
      });
      stripeRefundId = refundResult.refunds[0]?.refundId;
    } catch (err) {
      // The claim already committed. A refund that failed partway has recorded
      // `completedRefundCents`; anything still outstanding self-heals through
      // the durable recovery queue, which replays the SAME Stripe key
      // (booking_cancel_refund_<bookingId>) so a Stripe-succeeded-but-unrecorded
      // refund is replayed, not repeated. Do NOT rethrow.
      const completedRefundCents =
        err instanceof PartialRefundError ? err.completedRefundCents : 0;
      const remaining = refundAmountCents - completedRefundCents;
      if (remaining > 0) {
        await enqueueBookingCancellationRefundRecovery({
          bookingId,
          paymentId,
          amountCents: remaining,
        }).catch((enqueueErr) =>
          logger.error(
            { err: enqueueErr, bookingId, paymentId, remaining },
            "Failed to enqueue booking cancellation refund recovery"
          )
        );
      }
      logger.error(
        { err, bookingId, paymentId, refundAmountCents, completedRefundCents },
        "Booking cancellation card refund failed; booking stays CANCELLED and the remainder is enqueued for recovery"
      );
    }

    // Queue the Xero credit note durably (allocated against the original invoice).
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero refund credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: payment.changeFeeCents > 0
        ? `Refund ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents`
        : `Refund ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
      metadata: {
        refundMethod: "card",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: payment.changeFeeCents,
        creditRestoredCents,
        stripeRefundId: stripeRefundId ?? null,
      },
    });

    await recordCancellationEvent({
      bookingId,
      actorMemberId: sessionUserId,
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% card refund under the policy in effect at the time.`,
      refundMethod: "card",
      refundPercentage,
      paidAmountCents,
      settledAmountCents: refundAmountCents,
      changeFeeCents: payment.changeFeeCents,
    });
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: sessionUserId,
      amountCents: refundAmountCents,
      reason: `${refundPercentage}% refunded to the original payment method.`,
    });

    sendBookingCancelledEmail(
      fresh.member.email,
      fresh.member.firstName,
      fresh.checkIn,
      fresh.checkOut,
      refundAmountCents,
      "card",
      creditRestoredCents
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after card refund cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "card",
        creditRestoredCents: creditRestoredCents || undefined,
        stripeRefundId,
        message: `Booking cancelled. ${refundPercentage}% refund of $${(refundAmountCents / 100).toFixed(2)} processed.`,
      },
    };
  }

  // ── Zero-refund branch (0% policy) ────────────────────────────────
  // The status flip and additionalPaymentStatus:"FAILED" already committed in
  // tx1, so there is no money movement left here — only the narrative work.
  await cleanupPromoRedemption(bookingId);

  logBookingCancellationAudit({
    booking: fresh,
    bookingId,
    sessionUserId,
    details: "No refund per cancellation policy",
    ipAddress,
    metadata: {
      refundAmountCents: 0,
      refundPercentage,
      refundMethod: "card",
      creditRestoredCents,
      failedOutstandingAdditionalPayment: shouldFailAdditionalPayment,
    },
  });

  await recordCancellationEvent({
    bookingId,
    actorMemberId: sessionUserId,
    policySummary: `Cancelled ${days} day(s) before check-in: no refund was due under the policy in effect at the time.`,
    refundMethod: "card",
    refundPercentage,
    paidAmountCents,
    settledAmountCents: 0,
    changeFeeCents: payment.changeFeeCents,
  });

  sendBookingCancelledEmail(
    fresh.member.email,
    fresh.member.firstName,
    fresh.checkIn,
    fresh.checkOut,
    0,
    "card",
    creditRestoredCents
  ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

  // Trigger waitlist processing for freed dates
  processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut })
    .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after no-refund cancellation"));

  return {
    status: 200,
    data: {
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      refundMethod: "card",
      creditRestoredCents: creditRestoredCents || undefined,
      message:
        "Booking cancelled. No refund applicable per cancellation policy.",
    },
  };
}

type CancellationAuditBooking = {
  memberId: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
  payment?: {
    id?: string | null;
    status?: string | null;
    amountCents?: number | null;
    refundedAmountCents?: number | null;
    changeFeeCents?: number | null;
    creditAppliedCents?: number | null;
  } | null;
};

function logBookingCancellationAudit({
  booking,
  bookingId,
  sessionUserId,
  details,
  ipAddress,
  metadata,
}: {
  booking: CancellationAuditBooking;
  bookingId: string;
  sessionUserId: string;
  details: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
}) {
  logAudit({
    action: "booking.cancel",
    memberId: sessionUserId,
    targetId: bookingId,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: bookingId,
    category: "booking",
    severity: "critical",
    outcome: "success",
    summary: "Booking cancelled",
    details,
    metadata: {
      statusBefore: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      paymentId: booking.payment?.id ?? null,
      paymentStatus: booking.payment?.status ?? null,
      paidAmountCents: booking.payment?.amountCents ?? null,
      refundedAmountCents: booking.payment?.refundedAmountCents ?? null,
      creditAppliedCents: booking.payment?.creditAppliedCents ?? null,
      ...metadata,
    },
    ipAddress,
  });
}

/**
 * Write the durable CANCELLED BookingEvent (issue #740). For a cancellation
 * after a captured payment, the policy snapshot + settled/retained amounts are
 * frozen here so the narrative can be rebuilt exactly later, even after the
 * AuditLog has been retention-pruned. Pre-payment cancellations carry no
 * snapshot. Call after the cancellation has committed.
 */
async function recordCancellationEvent(params: {
  bookingId: string;
  actorMemberId: string;
  policySummary: string;
  refundMethod: "card" | "credit";
  refundPercentage: number;
  paidAmountCents: number;
  settledAmountCents: number;
  changeFeeCents: number;
}): Promise<void> {
  const retainedAmountCents = Math.max(
    params.paidAmountCents - params.settledAmountCents,
    0
  );
  await recordBookingEvent({
    bookingId: params.bookingId,
    type: BookingEventType.CANCELLED,
    actorMemberId: params.actorMemberId,
    amountCents: params.paidAmountCents,
    snapshot: {
      policySummary: params.policySummary,
      refundMethod: params.refundMethod,
      refundPercentage: params.refundPercentage,
      paidAmountCents: params.paidAmountCents,
      settledAmountCents: params.settledAmountCents,
      retainedAmountCents,
      changeFeeCents: params.changeFeeCents,
    },
  });
}

function hasOutstandingAdditionalPaymentIntent(
  payment:
    | {
        additionalPaymentIntentId?: string | null;
        additionalPaymentStatus?: string | null;
      }
    | null
    | undefined
) {
  return Boolean(
    payment?.additionalPaymentIntentId &&
      payment.additionalPaymentStatus !== "SUCCEEDED" &&
      payment.additionalPaymentStatus !== "FAILED"
  );
}

async function cancelOutstandingPaymentIntents({
  primaryPaymentIntentId,
  additionalPaymentIntentId,
  cancelPrimary,
  cancelAdditional,
}: {
  primaryPaymentIntentId?: string | null;
  additionalPaymentIntentId?: string | null;
  cancelPrimary: boolean;
  cancelAdditional: boolean;
}) {
  const paymentIntentIds = new Set<string>();

  if (cancelPrimary && primaryPaymentIntentId) {
    paymentIntentIds.add(primaryPaymentIntentId);
  }

  if (cancelAdditional && additionalPaymentIntentId) {
    paymentIntentIds.add(additionalPaymentIntentId);
  }

  for (const paymentIntentId of paymentIntentIds) {
    try {
      await cancelPaymentIntentIfCancellable(paymentIntentId);
      await markPaymentIntentTransactionFailed({ paymentIntentId });
    } catch (err) {
      logger.error(
        { err, paymentIntentId },
        "Failed to cancel Stripe PaymentIntent for cancelled booking"
      );
      throw err;
    }
  }
}

/**
 * Clean up promo redemption if booking used a promo code.
 */
async function cleanupPromoRedemption(bookingId: string) {
  const redemption = await prisma.promoRedemption.findUnique({
    where: { bookingId },
  });
  if (redemption) {
    await prisma.$transaction(async (tx) => {
      await deletePromoRedemptionAndAdjustCount(tx, redemption);
    });
  }
}
