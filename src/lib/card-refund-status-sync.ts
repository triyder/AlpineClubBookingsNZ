/**
 * #4104 (`INV-PAY-128`): bringing a card refund's recorded status up to date
 * with Stripe, so one that Stripe accepted and failed later is seen and owed
 * again (`card-refund-failed-later.ts`).
 *
 * Two ways in, both through the one writer of a transaction's refund rows
 * (`recordStripeRefundsAgainstTransaction`), which sees the failure exactly once
 * and keeps it owed in the same transaction:
 *
 * - **The webhook** (`refund.failed`, and `refund.updated` /
 *   `charge.refund.updated` where subscribed): `recordRefusedCardRefund`.
 * - **The payments cron** (`reconcilePendingCardRefunds`): each refund still
 *   recorded `pending` is read back from Stripe, so a missed or unsubscribed
 *   event is caught within a run or two.
 *
 * An organiser child's refund (no transaction of its own) is not read here:
 * `reconcilePendingOrganiserChildRefunds` owns it (`INV-PAY-114`).
 */
import type Stripe from "stripe";

import logger from "@/lib/logger";
import { EXCLUDED_LEDGER_REFUND_STATUSES, isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { findPaymentTransactionByIntentId, recordStripeRefundsAgainstTransaction } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { retrieveRefund } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";

export type RefusedCardRefundOutcome = "not-refused" | "not-a-card-payment" | "recorded";

/**
 * Record a refund Stripe reports failed or cancelled against its charge. Only
 * a refusal is written: a refund that counts is the `charge.refunded` sync's,
 * which queues its Xero note. Idempotent - a replay finds the row already
 * refused and writes nothing - and safe before the refund's own writer has
 * recorded it: the row is written refused, and that writer, told by Stripe the
 * refund counts, reads the row and keeps it owed. Throws when the write fails,
 * so the webhook answers 500 and Stripe sends it again.
 *
 * STATED LIMIT (delta review B-2): a first-seen failure owes nothing, because
 * it cannot tell a door still on its way from one that crashed before recording
 * - owing it would owe it twice whenever the door lives. A door with no row
 * persisted before its call that crashes there leaves no debt, as the same
 * crash before the call would (`docs/CONCURRENCY_AND_LOCKING.md`).
 */
export async function recordRefusedCardRefund(refund: Stripe.Refund): Promise<RefusedCardRefundOutcome> {
  if (!isRefusedRefundStatus(refund.status)) return "not-refused";
  const known = await prisma.paymentRefund.findUnique({
    where: { stripeRefundId: refund.id },
    select: { paymentId: true, paymentTransactionId: true, stripePaymentIntentId: true },
  });
  if (known && !known.paymentTransactionId) return "not-a-card-payment";
  const paymentIntentId = stripeReferenceId(refund.payment_intent) ?? known?.stripePaymentIntentId ?? null;
  const target =
    known?.paymentTransactionId
      ? { paymentId: known.paymentId, paymentTransactionId: known.paymentTransactionId }
      : paymentIntentId
        ? await findPaymentTransactionByIntentId({ paymentIntentId }).then((transaction) =>
            transaction ? { paymentId: transaction.paymentId, paymentTransactionId: transaction.id } : null,
          )
        : null;
  if (!target) {
    logger.info({ stripeRefundId: refund.id, paymentIntentId }, "A refused Stripe refund matches no card payment here (#4104)");
    return "not-a-card-payment";
  }
  await recordStripeRefundsAgainstTransaction({
    ...target,
    refunds: [refund],
    fallbackChargeId: stripeReferenceId(refund.charge),
    fallbackPaymentIntentId: paymentIntentId,
  });
  return "recorded";
}

/**
 * One read's bound, with no retries, and the whole sweep's: a Stripe brown-out
 * never stalls the cron behind it. Shared by every refund read-back the
 * payments cron runs (#4130: the organiser-child one too).
 */
export const READ_BACK_TIMEOUT_MS = 10_000;
export const READ_BACK_BUDGET_MS = 60_000;

/**
 * The payments cron's read-back: each card refund still recorded as neither
 * made nor refused (`pending`, `requires_action`) is read from Stripe, and one
 * whose status moved is recorded - a failure is kept owed, a success just
 * brings the row up to date. Least recently read first, and each one read -
 * or that could not be read or recorded - is stamped, so neither a refund
 * Stripe keeps pending for days nor one that keeps failing can hog a slot.
 * One refund failing never stops the others; the sweep stops when its time
 * budget is spent. Never inside a transaction with the provider call.
 */
export async function reconcilePendingCardRefunds(
  stripe: { retrieveRefund: typeof retrieveRefund } = { retrieveRefund },
  limit = 25,
  budgetMs = READ_BACK_BUDGET_MS,
): Promise<{ checked: number; moved: number }> {
  const pending = await prisma.paymentRefund.findMany({
    where: { paymentTransactionId: { not: null }, status: { notIn: [...EXCLUDED_LEDGER_REFUND_STATUSES, "succeeded"] } },
    select: { stripeRefundId: true, paymentId: true, paymentTransactionId: true, status: true, stripePaymentIntentId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let moved = 0;
  let checked = 0;
  const startedAt = performance.now();
  // Guarded on the status read: a concurrent write to the row is never overwritten.
  const stamp = (row: (typeof pending)[number]) =>
    prisma.paymentRefund.updateMany({ where: { stripeRefundId: row.stripeRefundId, status: row.status }, data: { updatedAt: new Date() } });
  for (const row of pending) {
    if (performance.now() - startedAt >= budgetMs) break;
    checked += 1;
    try {
      const refund = await stripe.retrieveRefund(row.stripeRefundId, { timeoutMs: READ_BACK_TIMEOUT_MS });
      if ((refund.status ?? row.status) === row.status) {
        await stamp(row);
        continue;
      }
      await recordStripeRefundsAgainstTransaction({
        paymentId: row.paymentId,
        paymentTransactionId: row.paymentTransactionId!,
        refunds: [refund],
        fallbackPaymentIntentId: row.stripePaymentIntentId,
      });
      moved += 1;
    } catch (err) {
      logger.error({ err, stripeRefundId: row.stripeRefundId }, "Could not bring a pending card refund up to date from Stripe (#4104)");
      await stamp(row).catch((stampErr: unknown) =>
        logger.error({ err: stampErr, stripeRefundId: row.stripeRefundId }, "Could not stamp a pending card refund's read-back (#4104)"),
      );
    }
  }
  return { checked, moved };
}
