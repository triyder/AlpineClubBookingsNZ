import { prisma } from "@/lib/prisma";
import {
  BookingEventType,
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
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
  enqueueDuplicateCaptureRefundRecovery,
  findOtherDuplicateCaptureRefundOperation,
  markCapacityClaimFailedRefundRecoverySucceeded,
  markDuplicateCaptureRefundRecoverySucceeded,
  recordCapacityClaimFailedRefundRecoveryInlineError,
  recordDuplicateCaptureRefundRecoveryInlineError,
} from "@/lib/payment-recovery";
import {
  buildBookingModificationRefundMetadata,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  deriveBookingAppliedCreditCents,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import {
  recordBookingEvent,
  recordDuplicateCaptureRefundEvent,
} from "@/lib/booking-events";
import {
  sendAdminDuplicateCaptureRefundAlert,
  sendAdminPaymentFailureAlert,
} from "@/lib/email";
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
    | "cancelled_refund_failed"
    // #1992 — a SECOND, distinct Stripe capture arrived on an already-PAID
    // booking (the residual #1967 split-child window). The duplicate capture
    // was auto-refunded (or a durable refund operation is pending for the
    // recovery cron when the inline attempt failed). The booking itself stays
    // settled by the other capture, so callers that only branch on the
    // cancelled_* outcomes keep treating these as "settled".
    | "duplicate_capture_refunded"
    | "duplicate_capture_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUS_LIST = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
] as const;

const PAYABLE_SUCCESS_STATUSES = new Set<string>(PAYABLE_SUCCESS_STATUS_LIST);

// #1992 (superseded-handoff exclusion) — the pre-existing superseded-intent
// machinery (booking-payment-cleanup queues a CANCEL_PAYMENT_INTENT recovery
// operation; when the cancel loses to a late capture, payment-recovery's
// handoff marks that transaction SUCCEEDED and queues a
// REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently produces
// EXACTLY the shape the duplicate-capture predicate below hunts for: another
// SUCCEEDED PRIMARY Stripe capture with net cash under a different intent id,
// with no duplicate_capture adjudication marker (the handoff never passes
// through markBookingPaymentSucceeded). That capture's money is already spoken
// for — the recovery cron will refund it under its
// `payment_recovery_refund_<txn>_<pi>` key — so treating it as "the
// settlement" would refund the REAL settlement as the duplicate and, once the
// cron also refunds the superseded capture, leave the booking PAID at zero net
// cash. A superseded-machinery operation counts as LIVE while it is not
// SUCCEEDED: PENDING, PROCESSING and FAILED (retrying or exhausted, where the
// money is still adjudicated to that machinery and admins were alerted). A
// SUCCEEDED cancel operation either actually cancelled the intent (its
// transaction is FAILED — never a predicate candidate) or handed off to a
// refund operation that is enqueued BEFORE the cancel operation completes; a
// SUCCEEDED refund operation leaves the transaction REFUNDED, which predicate
// (b) already excludes. So `status != SUCCEEDED` across both types covers the
// whole handoff window with no gap.
const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Run under lock(1) inside
 * the reconciliation transaction; the result feeds the `notIn` exclusion of
 * the duplicate-capture candidate query.
 */
async function listLiveSupersededIntentIds(
  tx: Prisma.TransactionClient,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? Used
 * to re-check the matched "settlement" candidate so that even if it slipped
 * the (b′) exclusion, the arriving capture stays plain already_paid.
 */
async function findLiveSupersededIntentOperation(
  tx: Prisma.TransactionClient,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: {
      paymentIntentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { id: true },
  });
}

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
    // Two-tier lock protocol (#1881). A Stripe capture does BOTH tiers of work:
    // it flips the booking's status + moves money (the booking-status/money
    // tier), AND it claims capacity (the per-lodge tier). It must therefore
    // hold BOTH locks, and the global lock(1) is taken FIRST — always
    // global-before-per-lodge, so the ordering is deadlock-free against every
    // other two-lock writer (invoice-paid-effects, confirm-pending-guests).
    // Without lock(1) this capture no longer mutually excluded the cancel /
    // hold-release / settlement paths (which serialise on lock(1)); a concurrent
    // cancel could interleave and the bare PAID write below could resurrect a
    // just-cancelled booking. The per-lodge lock still serialises the capacity
    // claim against per-lodge creators.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying
    // the per-lodge lock from this read is safe; every status/capacity-relevant
    // field is taken from the post-lock re-read below.
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

      // #1992 — duplicate-capture detection. `already_paid` is the normal
      // exactly-once replay outcome for a success that carries the SAME intent
      // the booking settled with (webhook redelivery, the confirm-payment
      // route racing the webhook, payment-link reconcile, charge-saved-method
      // and cron-confirm-pending reruns replaying their `pending_charge_`
      // Stripe idempotency key, confirm-pending-guests retries). But a
      // DIFFERENT intent capturing against an already-PAID booking is double
      // money: the residual #1967 split-child window, where the /pay link
      // intent (client secret already in the member's browser) and the
      // settlement cron's saved-card charge both capture. Refund the arriving
      // duplicate automatically instead of stranding it behind a manual
      // reconcile. The refund debt is enqueued here, ATOMIC with this
      // transaction and BEFORE any Stripe call (the #1349 pattern); the Stripe
      // refund itself executes after commit, below.
      //
      // Distinctness predicate — refund the arriving intent ONLY when all of:
      //   (a) the arriving intent has no refund history (#1765 guard above —
      //       an already-(partly-)refunded replay stays plain already_paid);
      //   (b) ANOTHER captured PRIMARY Stripe transaction with net cash
      //       (SUCCEEDED or PARTIALLY_REFUNDED — deliberately NOT fully
      //       REFUNDED, so a #1765 repay-generation replay arriving alongside
      //       its refunded predecessor is never treated as a duplicate) exists
      //       on this payment under a different intent id;
      //   (b′) that other capture's money is NOT already owned by the
      //       superseded-intent machinery (a live CANCEL_PAYMENT_INTENT /
      //       REFUND_SUPERSEDED_PAYMENT recovery operation — see
      //       SUPERSEDED_INTENT_OPERATION_TYPES). The handoff of a superseded
      //       intent's late capture sets it SUCCEEDED with a queued refund
      //       WITHOUT ever passing through this function, so from the ledger
      //       alone it is indistinguishable from a settlement; refunding the
      //       arriving capture against it would refund the REAL settlement
      //       while the cron refunds the superseded one — zero net cash;
      //   (c) no duplicate-capture refund has already been adjudicated for
      //       this booking against a DIFFERENT intent. Without (c), webhook
      //       replays of BOTH captures would refund both sides (Y settles, X
      //       arrives → refund X; Y's redelivery then sees X SUCCEEDED-and-
      //       different → refund Y too) and settle the booking at zero net
      //       cash. lock(1), held by every caller of this function, serialises
      //       the check-then-enqueue, so exactly one side of the pair can ever
      //       open a refund operation;
      //   (c′) belt-and-braces re-check of (b′) against the matched candidate
      //       directly (different query shape) — if a live superseded-intent
      //       operation owns the candidate's money, the arriving capture is
      //       the settlement side and stays plain already_paid.
      // All of these run inside the same lock(1) transaction.
      if (!refundedIntentHistory) {
        const liveSupersededIntentIds = await listLiveSupersededIntentIds(
          tx,
          payment.id
        );
        const otherSettledCapture = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: payment.id,
            kind: PaymentTransactionKind.PRIMARY,
            source: PaymentSource.STRIPE,
            status: {
              in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
            },
            stripePaymentIntentId: {
              not: paymentIntentId,
              notIn: liveSupersededIntentIds,
            },
            NOT: { stripePaymentIntentId: null },
          },
          select: { id: true, stripePaymentIntentId: true },
        });

        if (otherSettledCapture) {
          const adjudicatedElsewhere =
            await findOtherDuplicateCaptureRefundOperation({
              bookingId: booking.id,
              paymentIntentId,
              store: tx,
            });

          // (c′) — the candidate's own intent id re-checked against the live
          // superseded-machinery operations. Skipped when (c) already settled
          // the adjudication.
          const supersededOwnsOtherCapture =
            adjudicatedElsewhere || !otherSettledCapture.stripePaymentIntentId
              ? null
              : await findLiveSupersededIntentOperation(
                  tx,
                  otherSettledCapture.stripePaymentIntentId
                );

          // Re-read the arriving duplicate's row AFTER the upsert above so the
          // frozen refund slice targets exactly this capture's transaction and
          // its outstanding captured amount — never a newest-first allocation
          // that could touch the settlement capture.
          const duplicateTransaction =
            adjudicatedElsewhere || supersededOwnsOtherCapture
              ? null
              : await findPaymentTransactionByIntentId({
                  paymentIntentId,
                  store: tx,
                });
          const duplicateRefundCents = duplicateTransaction
            ? Math.min(
                amountCents,
                duplicateTransaction.amountCents -
                  duplicateTransaction.refundedAmountCents
              )
            : 0;

          if (duplicateTransaction && duplicateRefundCents > 0) {
            const refundPlan = [
              {
                paymentTransactionId: duplicateTransaction.id,
                amountCents: duplicateRefundCents,
              },
            ];
            await enqueueDuplicateCaptureRefundRecovery({
              bookingId: booking.id,
              paymentId: payment.id,
              paymentIntentId,
              amountCents: duplicateRefundCents,
              allocationPlan: refundPlan,
              store: tx,
            });

            return {
              outcome: "duplicate_capture" as const,
              booking,
              paymentId: payment.id,
              bumpedBookingIds: [] as string[],
              refundPlan,
              plannedRefundCents: duplicateRefundCents,
              settledPaymentIntentId: otherSettledCapture.stripePaymentIntentId,
            };
          }
        }
      }

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
      // Status-guarded void (#1881, defense in depth): claim the cancel only
      // while the booking is still in a payable state. Under lock(1) the
      // post-lock re-read already established that, so count 0 is a "cannot
      // happen" — but guarding the write means a concurrent status transition
      // that somehow slipped the lock can never be clobbered back to CANCELLED.
      const voided = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
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
      if (voided.count === 0) {
        throw new Error(
          "Booking status changed concurrently during the capacity-failed void (#1881)"
        );
      }
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

    // Status-guarded PAID claim (#1881, defense in depth alongside lock(1)):
    // only settle a still-payable booking. Under lock(1) count 0 cannot happen
    // (the re-read above already gated on this), but the guard means a cancel
    // that somehow raced past the lock cannot be resurrected to PAID.
    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      throw new Error(
        "Booking status changed concurrently during the PAID claim (#1881)"
      );
    }
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

  if (reconciliation.outcome === "duplicate_capture") {
    // #1992 — the arriving capture is duplicate money on a booking already
    // settled by a different intent. The durable refund debt committed with
    // the transaction above; everything below is the inline attempt at the
    // same frozen slice, executed OUTSIDE any database transaction. Loud on
    // purpose: money is moving automatically.
    const { refundPlan, plannedRefundCents, settledPaymentIntentId } =
      reconciliation;
    logger.error(
      {
        bookingId,
        duplicatePaymentIntentId: paymentIntentId,
        settledPaymentIntentId,
        refundCents: plannedRefundCents,
      },
      "Duplicate Stripe capture on an already-paid booking (#1992); auto-refunding the duplicate capture"
    );

    // #2008 — a durable, ADMIN-ONLY BookingEvent IS recorded for this refund
    // once its recovery operation reaches SUCCEEDED (see below), but it is a
    // REFUNDED event carrying the `duplicate_capture_refund` discriminator so
    // resolveBookingNarrative EXCLUDES it (isDuplicateCaptureRefundEvent) and
    // it can never masquerade as the settlement clause of a LATER member
    // cancellation. The rest of the audit trail is unchanged: the
    // PaymentRecoveryOperation row, the PaymentRefund ledger entries, this log
    // line and the admin alert below.
    try {
      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `duplicate_capture_refund_<bookingId>_<paymentIntentId>` key prefix
        // — Stripe replays the original refund instead of rejecting the
        // reused key with idempotency_error.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "duplicate_capture"
        ),
        idempotencyKeyPrefix: buildDuplicateCaptureRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slice/keys, which Stripe answers with the original refund.
      const markResult = await markDuplicateCaptureRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) => {
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark duplicate-capture refund recovery succeeded; the cron will replay the frozen plan idempotently"
        );
        return null;
      });

      // #2008 — record the admin-only history event EXACTLY ONCE, gated on this
      // call being the one that flipped the operation to SUCCEEDED (count > 0).
      // If the mark was lost or the cron already closed the operation, this
      // path records nothing and the cron-replay path owns the event, so the
      // inline and cron paths never double-record. Post-commit, base client.
      if (markResult && markResult.count > 0) {
        await recordDuplicateCaptureRefundEvent({
          bookingId,
          amountCents: plannedRefundCents,
          duplicatePaymentIntentId: paymentIntentId,
          settledPaymentIntentId: settledPaymentIntentId ?? null,
        });
      }

      // Alert the admins even on success: an automatic refund of a duplicate
      // charge is an anomaly worth eyes, and the alert is the operator's cue
      // to check how the double capture happened. Dedicated template (#2007)
      // whose success variant states the duplicate was refunded in full.
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        refundFailed: false,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the auto-refunded duplicate capture"
        )
      );

      return {
        outcome: "duplicate_capture_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The refund debt already committed with the frozen slice, so nothing
      // needs enqueueing here: the recovery cron replays it with backoff and
      // alerts on exhaustion. Record the inline error for operator visibility
      // and alert immediately as well.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund a duplicate capture; the pre-persisted recovery operation will replay the refund"
      );
      await recordDuplicateCaptureRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline duplicate-capture refund failure on the recovery operation"
        )
      );
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        errorMessage:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
        refundFailed: true,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the failed duplicate-capture refund"
        )
      );

      return {
        outcome: "duplicate_capture_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      };
    }
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
