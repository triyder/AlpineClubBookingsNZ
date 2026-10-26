/**
 * The refunded-total recount a bank-transfer settle owes after it KEEPS the
 * stored figure, or replays one already captured (#4095 items 5 and 12,
 * `INV-PAY-125`, `INV-PAY-126`).
 *
 * An invoice correction counts as refunded only against a receipt recorded at
 * the stored figure. A correction synced before the settle (or whose sync read
 * the payment while it was still uncaptured) found no such receipt and counted
 * nothing; the settle then captured the receipt at the stored figure, which
 * still includes the corrected amount. The keep counts such a correction in
 * its own transaction when it can (`keptCorrectionRefundCents` in
 * `settle-from-cash.ts`); this recount, after the commit, is the backstop: a
 * replay, a refunded total the keep left alone, and a correction whose sync
 * wrote its links while the settle ran.
 *
 * It is the inbound recount with no note being synced
 * (`repairRefundedPaymentBusinessState`, `creditNoteId: null`): every note,
 * the corrections included, counts from its links as the recount reads them,
 * after it reads the payment, with its claim on the row it read. It never
 * passes a status or an amount it read earlier, so a void that commits first
 * is never overwritten with the note counted (#4095 review, item 2). Runs after
 * the commit, outside any transaction, and takes no lock of its own. The repair
 * writes an absolute total, so running it again on a replay changes nothing
 * that is already right. One it could not finish (an error, or a claim lost
 * twice) returns the corrections' ids, and the inbound event fails on them
 * after every other write, so the event is retried and the replay recounts.
 */
import logger from "@/lib/logger";
import { repairRefundedPaymentBusinessState } from "./credit-note-repairs";
import type { AppliedCreditNote } from "./settle-from-cash";

export async function recountCorrectionsAfterKeptSettle(
  invoiceId: string,
  paymentId: string,
  correctionNotes: readonly AppliedCreditNote[],
): Promise<string[]> {
  if (correctionNotes.length === 0) return [];
  const noteIds = correctionNotes.map((note) => note.id);
  try {
    const repair = await repairRefundedPaymentBusinessState({
      creditNoteId: null,
      creditNote: {},
      directPaymentIds: [paymentId],
      modificationRefundAmountsByPaymentId: new Map(),
    });
    if (!repair.unsettledPaymentIds) return [];
    logger.error(
      { invoiceId, paymentId, creditNoteIds: noteIds },
      "The recount after a kept bank-transfer settle lost its claim twice; the invoice event fails so it is retried (#4095)",
    );
  } catch (err) {
    logger.error(
      { err, invoiceId, paymentId, creditNoteIds: noteIds },
      "Could not recount the invoice corrections after a kept bank-transfer settle; the invoice event fails so it is retried (#4095)",
    );
  }
  return noteIds;
}
