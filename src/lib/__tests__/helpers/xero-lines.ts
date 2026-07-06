/**
 * Shared cent-reconciliation rule for Xero line items in tests (#1356): a
 * document's lines must sum, in integer cents, to the ledger amount they were
 * built from. Signed lines (mixed-sign booking edits) participate with their
 * sign, so the sum is the net.
 */
export function lineTotalCents(
  lines: Array<{ quantity?: number; unitAmount?: number }>
) {
  return lines.reduce(
    (sum, line) =>
      sum + Math.round((line.quantity ?? 0) * (line.unitAmount ?? 0) * 100),
    0
  );
}
