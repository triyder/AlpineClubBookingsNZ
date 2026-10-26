import { PaymentStatus } from "@prisma/client";

/**
 * #1491 (review): the part of a PARTIALLY_REFUNDED payment mirror's refunded
 * total its capture ledger does not show - an invoice-applied credit note the
 * inbound reconcile folded into `Payment.refundedAmountCents` without touching
 * a transaction row - attributed to the captured rows OLDEST FIRST, each up to
 * what it will take.
 *
 * ONE walk for the paid cancel's claim, which writes each step
 * (`foldIntoTransactionRefundedAmount`, capped at the row's headroom), and the
 * cancel preview (#4119, `INV-PAY-131`), which applies the same steps to its
 * read in memory (`refundHeadroomIncrementCents`), so both plan the card refund
 * from the same ledger. `readCapturedRowsOldestFirst` is asked only for a
 * partly refunded payment, and reads in `LEDGER_ROWS_OLDEST_FIRST`
 * (`payment-ledger-order.ts`, #4132), so a tie between captured rows always
 * folds onto the row inserted first; `apply` returns what the row actually
 * took, and the rest moves on to the next row.
 */
export async function foldMirrorRefundIntoLedger<R extends { refundedAmountCents: number }>(
  payment: { status: PaymentStatus | string; refundedAmountCents: number },
  readCapturedRowsOldestFirst: () => Promise<readonly R[]> | readonly R[],
  apply: (row: R, cents: number) => Promise<number> | number,
): Promise<void> {
  if (payment.status !== PaymentStatus.PARTIALLY_REFUNDED) return;
  const rows = await readCapturedRowsOldestFirst();
  let foldedCents = payment.refundedAmountCents - rows.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  for (const row of rows) {
    if (foldedCents <= 0) break;
    foldedCents -= await apply(row, foldedCents);
  }
}
