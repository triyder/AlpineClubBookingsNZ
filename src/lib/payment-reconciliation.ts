import { prisma } from "@/lib/prisma";
import {
  BookingEventType,
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import {
  findPaymentTransactionByIntentId,
  planStripeRefundAllocation,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  enqueueCapacityClaimFailedRefundRecovery,
  markCapacityClaimFailedRefundRecoverySucceeded,
  recordCapacityClaimFailedRefundRecoveryInlineError,
} from "@/lib/payment-recovery";
import {
  buildBookingModificationRefundMetadata,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  deriveBookingAppliedCreditCents,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId } from "@/lib/lodges";
import {
  bookingHasCapacityOverride,
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";

type ReconciliationBooking = Prisma.BookingGetPayload<{
  include: {
    guests: true;
    member: true;
  };
}>;

export type MarkBookingPaymentSucceededResult = {
  outcome:
    | "paid"
    | "already_paid"
    | "cancelled_refunded"
    | "cancelled_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUSES = new Set<string>([
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
]);

async function alertRefundFailure({
  booking,
  paymentIntentId,
  amountCents,
  error,
}: {
  booking: ReconciliationBooking;
  paymentIntentId: string;
  amountCents: number;
  error: unknown;
}) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents,
    errorMessage: `Payment succeeded but final capacity claim failed and automatic refund failed: ${errorMessage}`,
    paymentIntentId,
  }).catch((alertErr) =>
    logger.error(
      { err: alertErr, bookingId: booking.id, paymentIntentId },
      "Failed to alert admins about capacity refund failure"
    )
  );
}

export async function markBookingPaymentSucceeded({
  bookingId,
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
}): Promise<MarkBookingPaymentSucceededResult> {
  const reconciliation = await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; every status/capacity-relevant field is
    // taken from the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });

    if (!lockTarget) {
      throw new Error("Booking not found");
    }

    const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; the status/amount checks, the
    // capacity check and the PAID/CANCELLED claim below consume ONLY this
    // post-lock snapshot.
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: { include: { nights: true } }, // per-night sets (issue #713)
        member: true,
      },
    });

    if (!booking) {
      throw new Error("Booking not found");
    }

    // #1641 — split the captured amount into cash + credit so the mirror invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds for BOTH a new
    // effective capture (credit = applied) and a legacy full-price capture
    // (credit = 0, repaired locally by the audit — never a Xero over-allocation).
    // This is derived from the captured amount alone; the ledger is only read below
    // when the amount is NOT the full price (to admit the effective capture).
    const mirrorCreditAppliedCents = Math.max(
      0,
      booking.finalPriceCents - amountCents
    );

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    // #1765 — refund history is immutable: an intent whose transaction was
    // refunded (fully or partially) must never be re-admitted as settlement,
    // whichever path (intent-route recovery, confirm-payment, webhook
    // redelivery, payment link) carries the succeeded intent back here.
    // Without this guard a redelivered success event for a refunded intent
    // would clobber the transaction row back to SUCCEEDED and, when the
    // booking price never changed, settle the booking at zero net cash. The
    // lookup backfills pre-ledger payments so legacy refund history is caught
    // too. Crashed-webhook recovery is untouched: its transaction is still
    // PENDING/PROCESSING (success was never recorded locally).
    const priorTransaction = await findPaymentTransactionByIntentId({
      paymentIntentId,
      store: tx,
    });
    const refundedIntentHistory =
      priorTransaction !== null &&
      (priorTransaction.status === PaymentStatus.REFUNDED ||
        priorTransaction.status === PaymentStatus.PARTIALLY_REFUNDED);

    if (!refundedIntentHistory) {
      await upsertPaymentIntentTransaction({
        paymentId: payment.id,
        kind: PaymentTransactionKind.PRIMARY,
        paymentIntentId,
        amountCents,
        status: PaymentStatus.SUCCEEDED,
        paymentMethodId,
        store: tx,
      });
    }

    if (booking.status === BookingStatus.PAID) {
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      // A refunded-history redelivery on an already-PAID booking (e.g. a
      // Stripe event replay after a partial goodwill refund) stays benign —
      // and, with the guard above, no longer clobbers the refund marker.
      return {
        outcome: "already_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    if (refundedIntentHistory) {
      // #1765 — the booking is not settled and the carried intent's money was
      // handed back. Re-admitting it would settle the booking at zero net
      // cash; the member owes a fresh payment (the create-payment-intent
      // route mints the repay intent at the current effective price).
      throw new Error(
        "Refunded payment intent cannot be re-admitted as settlement; the booking needs a fresh payment (#1765)"
      );
    }

    if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
      throw new Error(`Booking is not payable from status ${booking.status}`);
    }

    // #1641 — accept EITHER the credit-reduced effective price (new intents) OR
    // the full finalPriceCents (legacy in-flight intents minted before the fix).
    // A wrong-amount capture (e.g. a stale intent from a since-changed price, #1161)
    // equals neither and is still rejected. Full price is always a legitimate
    // settlement of a full-price booking's invoice, so admitting it can never
    // under-charge the member; new bookings never mint a full-price intent, so the
    // leniency does not re-open the double-charge. The ledger read is skipped
    // entirely for a full-price capture.
    if (amountCents !== booking.finalPriceCents) {
      const appliedCreditCents = await deriveBookingAppliedCreditCents(
        booking.id,
        tx
      );
      if (amountCents !== booking.finalPriceCents - appliedCreditCents) {
        throw new Error("Payment amount does not match booking total");
      }
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    // Since #737/#738 a PENDING booking holds no capacity, so there is no
    // synchronous bump that could free a real bed. An all-member booking that
    // does not fit against committed bookings is cancelled-and-refunded here,
    // never bumped into a full lodge (issue #738, carried over from R1). The
    // non-member portion of a mixed party is now its own provisional booking.
    if (!capacity.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): this booking was deliberately
      // admitted above the ceiling by an admin. Settle it instead of cancelling
      // — fall through to the PAID update below.
      //
      // Whole-lodge hold (ADR-001, issue #118) is DELIBERATELY not enforced on
      // this settle path (and the other persisted-override settlements: cron-
      // confirm-pending, switch-to-internet-banking, charge-saved-method,
      // payment-link, xero-inbound invoice-paid-effects, group-settlement).
      // Those settle a PRE-EXISTING overridden booking; a hold may have been
      // placed over it AFTERWARDS. Per ADR-001 decision 1 (conflicts are
      // allowed, surfaced, and manually resolved — no auto-displacement/refusal)
      // an already-admitted booking is not a "new admission", so auto-refusing
      // it here would contradict decision 1. The hold blocks only NEW admissions
      // (decision 5), enforced at the admission choke points (booking-create,
      // date/modify-plan, and the admin allowOverbook routes force-confirm /
      // confirm-pending-guests / capacity-hold).
      logger.info(
        { bookingId: booking.id },
        "Settling an over-capacity booking with a persisted capacity override (#1771); skipping the capacity cancel"
      );
    }
    if (!capacity.available && !bookingHasCapacityOverride(booking)) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          // Best-effort field clearing (#177): this settlement capacity-cancel
          // has no per-booking audit context, so it mirrors the capacity-hold
          // sibling — clear the stale hold, no released audit. NB this is the
          // NON-override branch; the documented decision-1 carve-out settlement
          // (the override branch above) is untouched.
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await restoreCreditFromBooking(booking.memberId, booking.id, tx);

      // Durable refund debt, ATOMIC with the cancel claim (mirrors the #1349
      // enqueue-then-execute pattern in booking-cancel): freeze the refund
      // allocation from this locked read and persist the recovery operation
      // BEFORE any Stripe call. A transient inline refund failure below — or
      // a process death between this commit and the refund — now leaves a
      // PENDING operation the recovery cron replays with backoff, instead of
      // the member's full charge stranded on a CANCELLED booking with only a
      // best-effort alert email as remediation. The frozen plan makes
      // inline-vs-cron replay exactly-once: both execute identical slices, so
      // both mint identical `capacity_claim_failed_<bookingId>_<pi>_<txn>_
      // <amount>` Stripe keys, Stripe answers repeats with the original
      // refunds, and the ledger dedupes on refund id.
      const { slices: refundPlan, plannedAmountCents: plannedRefundCents } =
        await planStripeRefundAllocation({
          paymentId: payment.id,
          amountCents,
          store: tx,
        });
      if (plannedRefundCents > 0) {
        await enqueueCapacityClaimFailedRefundRecovery({
          bookingId: booking.id,
          paymentId: payment.id,
          paymentIntentId,
          amountCents: plannedRefundCents,
          allocationPlan: refundPlan,
          store: tx,
        });
      }

      return {
        outcome: "capacity_failed" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
        refundPlan,
        plannedRefundCents,
      };
    }

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    return {
      outcome: "paid" as const,
      booking,
      paymentId: payment.id,
      bumpedBookingIds: [] as string[],
    };
  });

  if (reconciliation.outcome === "paid") {
    // Single durable "paid" fact for every payment path (session, webhook,
    // payment link, cron auto-charge). A provisional non-member child booking
    // (parentBookingId set) is recorded as confirmed/charged; everything else
    // is the member paying up front (issue #740).
    await recordBookingEvent({
      bookingId,
      type: reconciliation.booking.parentBookingId
        ? BookingEventType.NON_MEMBER_CONFIRMED
        : BookingEventType.MEMBER_PAID,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
    });
  }

  if (reconciliation.outcome === "capacity_failed") {
    // Payment succeeded but the final capacity claim failed: the booking was
    // cancelled inside the transaction and is auto-refunded here (issue #740).
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
      reason:
        "These dates filled up before payment could be secured, so the booking was cancelled and refunded.",
      snapshot: {
        policySummary:
          "These dates were no longer available when payment completed, so the full amount was refunded.",
        refundMethod: "card",
        refundPercentage: 100,
        paidAmountCents: amountCents,
        settledAmountCents: amountCents,
        retainedAmountCents: 0,
      },
    });

    // The refund debt was persisted INSIDE the claim transaction with the
    // frozen allocation plan (see the enqueue above): everything below is the
    // inline attempt at the same slices, and any failure leaves the PENDING
    // operation for the recovery cron — never a stranded charge that only an
    // alert email knows about.
    const { refundPlan, plannedRefundCents } = reconciliation;
    if (plannedRefundCents < amountCents) {
      // Mirror-vs-ledger drift (same guard as booking-cancel): refund what
      // the payment ledger actually shows refundable and surface the gap.
      logger.error(
        { bookingId, paymentIntentId, amountCents, plannedRefundCents },
        "Capacity-race refund plan covers less than the captured amount; refunding what the payment ledger shows refundable"
      );
    }

    try {
      if (refundPlan.length === 0 || plannedRefundCents <= 0) {
        throw new Error(
          "Capacity-race refund plan is empty: no captured Stripe transaction to refund"
        );
      }

      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `capacity_claim_failed_<bookingId>_<paymentIntentId>` key prefix —
        // Stripe replays the original refund instead of rejecting the reused
        // key with idempotency_error. The metadata deliberately carries only
        // values the cron can reconstruct from the persisted operation.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "capacity_claim_failed"
        ),
        idempotencyKeyPrefix: buildCapacityClaimFailedRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slices/keys, which Stripe answers with the original refunds.
      await markCapacityClaimFailedRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) =>
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark capacity-race refund recovery succeeded; the cron will replay the frozen plan idempotently"
        )
      );

      await recordBookingEvent({
        bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: reconciliation.booking.memberId,
        amountCents,
        reason: "Automatic refund after lodge capacity was no longer available.",
      });

      return {
        outcome: "cancelled_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The cancel claim already committed together with the recovery
      // operation, so nothing needs enqueueing here: the cron replays the
      // frozen plan with backoff and alerts on exhaustion. A partial success
      // has recorded its completed slices; the replay re-requests the SAME
      // slices/keys, so completed slices are replayed by Stripe, not
      // repeated, and only the remainder moves money. Record the inline
      // error on the operation and keep the immediate admin alert.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund booking after final capacity claim failed; the pre-persisted recovery operation will replay the refund"
      );
      await recordCapacityClaimFailedRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline capacity-race refund failure on the recovery operation"
        )
      );
      await alertRefundFailure({
        booking: reconciliation.booking,
        paymentIntentId,
        amountCents,
        error: refundError,
      });

      return {
        outcome: "cancelled_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error ? refundError.message : String(refundError),
      };
    }
  }

  return {
    outcome: reconciliation.outcome,
    bookingId,
    bumpedBookingIds: reconciliation.bumpedBookingIds,
  };
}

export async function markBookingSetupIntentSucceeded({
  bookingId,
  setupIntentId,
  paymentMethodId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
}) {
  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
    },
  });
}
