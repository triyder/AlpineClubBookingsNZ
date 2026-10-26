import type { ClubFormat } from "@/lib/club-format";
import type { RepairedLateCaptureXeroOutcome } from "@/lib/late-capture-repair-refund-record";
import { isRefusedRefundStatus, refusedRefundAnswerCents } from "@/lib/payment-transaction-status";
import { refusedRefundMessage } from "@/lib/refused-card-refund-retry";

/**
 * #4103 (`INV-PAY-130`): the refunds Stripe made. A refused one (`failed` or
 * `canceled`) sent nothing back, so it is never recorded or noted as refunded.
 * Each refund carries Stripe's status (`refundPaymentTransactions`); one with
 * none counts as made, as the ledger counts it.
 */
export function madeRepairRefunds<T extends { paymentIntentId: string; status?: string | null }>(refunds: ReadonlyArray<T>): T[] {
  return refunds.filter((refund) => !isRefusedRefundStatus(refund.status));
}

/**
 * #4103: the failed action's message when Stripe refused part of the repair's
 * refund - what was made and recorded, then what was refused - or null when
 * nothing was refused. A re-run asks again under a fresh key, read from the
 * refusals recorded (`sliceAfterRecordedRefusals`).
 */
export function describeRefusedRepairedLateCaptureRefund(
  refunds: ReadonlyArray<{ paymentIntentId: string; refundId?: string | null; amountCents: number; status?: string | null }>,
  xero: RepairedLateCaptureXeroOutcome,
  format: ClubFormat,
): string | null {
  const refusedCents = refusedRefundAnswerCents(refunds);
  if (refusedCents <= 0) return null;
  const made = madeRepairRefunds(refunds);
  return [
    made.length > 0 ? describeRepairedLateCaptureRefund(made, xero) : "",
    `${refusedRefundMessage(refusedCents, format)} That money is still with the club: run the repair again to ask Stripe again, or refund it in the Stripe dashboard.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * #3635 (N4): the operator's result message for a repaired late-capture
 * refund says only what happened: "recorded" only for the intents whose
 * record was written, "queued" only for a note that was queued, and a
 * suspected double payment always.
 */
export function describeRepairedLateCaptureRefund(
  refunds: ReadonlyArray<{ paymentIntentId: string; refundId?: string | null }>,
  xero: RepairedLateCaptureXeroOutcome,
): string {
  const refundIds = refunds.map((refund) => refund.refundId).filter(Boolean);
  const failed = new Set(xero.recordFailed);
  const recorded = [...new Set(refunds.map((refund) => refund.paymentIntentId))].filter(
    (intent) => intent && !failed.has(intent),
  );
  const sentences = [
    `Refunded ${refunds.length} Stripe payment intent(s) (${refundIds.join(", ")}).`,
  ];
  if (recorded.length > 0) {
    sentences.push(`Recorded the refund of ${recorded.join(", ")} as the webhook does.`);
  }
  if (xero.recordFailed.length > 0) {
    sentences.push(`Could not record the refund of ${xero.recordFailed.join(", ")}: a critical audit row names it, and no Xero refund credit note was raised. Record it and settle Xero by hand.`);
  }
  if (xero.doubleRefundSuspected.length > 0) {
    sentences.push(`An officer hand-completed the refund task for ${xero.doubleRefundSuspected.join(", ")} while this refund ran, so the member may have been paid twice: check the booking's refunds now.`);
  }
  if (xero.noted.length > 0) {
    sentences.push(`Queued the Xero refund credit note against the payment's own Xero receipt for ${xero.noted.join(", ")}.`);
  }
  if (xero.alreadyNoted.length > 0) {
    sentences.push(`The Xero refund credit note for ${xero.alreadyNoted.join(", ")} was already raised, so none was queued.`);
  }
  if (xero.noteFailed.length > 0) {
    sentences.push(`Could not queue the Xero refund credit note for ${xero.noteFailed.join(", ")}: raise it by hand in Xero.`);
  }
  if (xero.byHand.length > 0) {
    sentences.push(`An officer recorded ${xero.byHand.join(", ")} by hand in Xero: record the refund by hand in Xero too.`);
  }
  if (xero.notInXero.length > 0) {
    sentences.push(`Xero never recorded ${xero.notInXero.join(", ")}, so no refund credit note was raised; reconcile the Stripe bank lines by hand in Xero.`);
  }
  return sentences.join(" ");
}
