import type { Prisma } from "@prisma/client";
import { paidAnotherWayCloseNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { KEPT_LATE_CAPTURE_INVOICE_ROLE, KEPT_LATE_CAPTURE_PAYMENT_ROLE } from "@/lib/late-capture-kept-xero-rules";
import { findLateCaptureRefundPaidAnotherWay } from "@/lib/late-capture-paid-another-way";
import { readPaidAnotherWayLateCaptureXeroReceipt, type LateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";
import { prisma } from "@/lib/prisma";
import { lockKeptLateCaptureTask } from "@/lib/xero-kept-late-capture-invoice";

/**
 * #3924 rounds 6 to 8 (owner, 8 Oct 2026: "Record receipt, then credit" and
 * "Raise a refund note for all"; `INV-PAY-122`): THE SECOND STEP of a late
 * capture's refund closed as paid another way - its bank-transfer note, once
 * the capture's receipt is in Xero - and where that step stands, for the
 * repair tool. The receipt and its lock are `xero-kept-late-capture-invoice.ts`'s.
 */

/**
 * THE NOTE STEP, for whichever worker put the capture's receipt in Xero: the
 * kept receipt's (`createXeroKeptLateCaptureInvoice`, the receipt the close
 * queued), and - #3924 round 8 (owner, 8 Oct 2026: "Raise a refund note for
 * all") - a change's supplementary invoice released
 * for the capture (`createXeroSupplementaryInvoice`), which a close found
 * queued, sending or FAILED and so could not credit yet. Under the approval
 * task's row lock it reads the receipt as Xero now holds it
 * (`readPaidAnotherWayLateCaptureXeroReceipt`, the invoice the close's plan would name) and
 * queues the waiting close's note against it (`notePaidAnotherWayCloseOnReceipt`,
 * at most once). Nothing without an approval task, or a receipt not yet in
 * Xero. Returns the note row's id, or null. Throws on a failure; the caller
 * decides whether that fails its row.
 */
export async function queueWaitingPaidAnotherWayNote(paymentIntentId: string): Promise<string | null> {
  return (await runWaitingNoteStep(paymentIntentId)).noteOperationId;
}

/**
 * The step itself, saying too whether it queued the note NOW (round 10): read
 * under the same row lock, a close whose note row was already asked for is
 * answered with that row, never counted as newly queued.
 */
async function runWaitingNoteStep(
  paymentIntentId: string,
): Promise<{ noteOperationId: string | null; queuedNow: boolean }> {
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true },
  });
  if (!task) return { noteOperationId: null, queuedNow: false };
  const clubZone = await readClubTimeZoneOutsideRequest();
  // Imported here, not at the top: that module reaches the outbox, which
  // dispatches to the receipt's worker.
  const { notePaidAnotherWayCloseOnReceipt } = await import("@/lib/late-capture-refund-credit-note");
  return prisma.$transaction(async (tx) => {
    await lockKeptLateCaptureTask(tx, task.id);
    const receipt = await readPaidAnotherWayLateCaptureXeroReceipt(paymentIntentId, tx);
    if (receipt.kind !== "recorded" || receipt.invoiceId === null) return { noteOperationId: null, queuedNow: false };
    const close = await findLateCaptureRefundPaidAnotherWay(paymentIntentId, tx);
    const askedBefore =
      close !== null && close.paymentId !== null ? await closeNoteAsked(tx, close.paymentId, close.id) : false;
    const noteOperationId = await notePaidAnotherWayCloseOnReceipt({
      paymentIntentId,
      receiptInvoiceId: receipt.invoiceId,
      clubZone,
      store: tx,
    });
    return { noteOperationId, queuedNow: noteOperationId !== null && !askedBefore };
  });
}

/**
 * #3924 round 9 (`INV-PAY-122`): THE NIGHTLY RETRY OF THE NOTE STEP, for a
 * payment whose closes' own notes do not yet cover what they paid back
 * (`paidAnotherWayUncoveredCents`). A note step that failed after a change's
 * invoice reached Xero is only logged by that invoice's worker, so the credit
 * reconciliation cron runs it again for every late capture on the payment
 * whose approved refund was closed so: the one idempotent step above, each
 * under its approval task's row lock, queuing at most one note per close.
 * Returns how many notes it queued now (round 10): a close whose note row was
 * queued before is not counted again.
 */
export async function queueWaitingPaidAnotherWayNotesForPayment(paymentId: string): Promise<number> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { paymentId, status: "COMPLETED", lateCaptureApprovalIntentId: { not: null } },
    select: { lateCaptureApprovalIntentId: true },
  });
  let queued = 0;
  for (const { lateCaptureApprovalIntentId } of tasks) {
    if (lateCaptureApprovalIntentId && (await runWaitingNoteStep(lateCaptureApprovalIntentId)).queuedNow) queued += 1;
  }
  return queued;
}

/**
 * #3924 round 8 (money review, `INV-PAY-122`): WHERE A WAITING CLOSE'S RECEIPT
 * AND NOTE STAND, for the repair tool. The capture's receipt as Xero holds it
 * (`readPaidAnotherWayLateCaptureXeroReceipt`); whether the close's bank-transfer note was
 * ever asked for (its own rows, `paidAnotherWayCloseNoteRowsWhere`, in any
 * state but withdrawn - one an officer resolved by hand included, since the
 * resolve keeps its FAILED or PARTIAL status); and which of the receipt's
 * links the approval task carries - its invoice, and its Stripe payment,
 * which says a FAILED row may have reached Xero
 * (`keptReceiptMayHaveReachedXero`). Round 11: what is left to record by
 * hand when the receipt was resolved by hand (`recordByHandCents`). Round 12:
 * the capture's own card refunds less the refund notes naming it
 * (`readUnnotedLateCaptureCardRefunds`), plus what the close paid back -
 * never `PaymentTransaction.refundedAmountCents`, which also carries any
 * other hand-back allocated to the capture's row. Round 14: a card note sent
 * to Xero without a reply is never in that figure, but named apart
 * (`cardNoteMayBeInXeroCents`) for the officer to check Xero first.
 */
export interface PaidAnotherWayReceiptState {
  receipt: LateCaptureXeroReceipt;
  /** The close itself - its record and what it paid back (#3924 round 9). */
  close: { id: string; amountCents: number } | null;
  noteAsked: boolean;
  invoiceLinked: boolean;
  paymentLinked: boolean;
  recordByHandCents: number;
  cardNoteMayBeInXeroCents: number;
}

export async function readPaidAnotherWayReceiptState(paymentIntentId: string): Promise<PaidAnotherWayReceiptState> {
  const receipt = await readPaidAnotherWayLateCaptureXeroReceipt(paymentIntentId);
  const close = await findLateCaptureRefundPaidAnotherWay(paymentIntentId);
  const noteAsked =
    close !== null && close.paymentId !== null ? await closeNoteAsked(prisma, close.paymentId, close.id) : false;
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true, paymentId: true },
  });
  const roles = task
    ? (
        await prisma.xeroObjectLink.findMany({
          where: {
            localModel: "ManualRefundTask",
            localId: task.id,
            role: { in: [KEPT_LATE_CAPTURE_INVOICE_ROLE, KEPT_LATE_CAPTURE_PAYMENT_ROLE] },
            active: true,
          },
          select: { role: true },
        })
      ).map((link) => link.role)
    : [];
  const byHand = receipt.kind === "resolved-by-hand" && Boolean(task?.paymentId);
  const card = byHand
    ? await readCardRefundsByHand(task?.paymentId, paymentIntentId)
    : { byHandCents: 0, mayBeInXeroCents: 0 };
  return {
    receipt,
    close: close ? { id: close.id, amountCents: Math.max(0, close.amountCents ?? 0) } : null,
    noteAsked,
    invoiceLinked: roles.includes(KEPT_LATE_CAPTURE_INVOICE_ROLE),
    paymentLinked: roles.includes(KEPT_LATE_CAPTURE_PAYMENT_ROLE),
    recordByHandCents: card.byHandCents + (byHand ? Math.max(0, close?.amountCents ?? 0) : 0),
    cardNoteMayBeInXeroCents: card.mayBeInXeroCents,
  };
}

/**
 * Round 12: the capture's card refunds no note answers (see
 * `PaidAnotherWayReceiptState`), read only when the receipt was resolved by hand.
 */
async function readCardRefundsByHand(paymentId: string | null | undefined, paymentIntentId: string) {
  if (!paymentId) return { byHandCents: 0, mayBeInXeroCents: 0 };
  // Imported here, not at the top: that module reaches the outbox.
  const { readUnnotedLateCaptureCardRefunds } = await import("@/lib/late-capture-refund-credit-note");
  return readUnnotedLateCaptureCardRefunds(paymentId, paymentIntentId);
}

/** Was this close's bank-transfer note ever asked for: any row of it but a withdrawn one, resolved by hand included. */
async function closeNoteAsked(
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
  paymentId: string,
  closeId: string,
): Promise<boolean> {
  return (
    (await db.xeroSyncOperation.count({
      where: { ...paidAnotherWayCloseNoteRowsWhere(paymentId, closeId), status: { not: "CANCELLED" } },
    })) > 0
  );
}
