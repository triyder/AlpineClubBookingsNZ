/**
 * #3979 (`INV-PAY-125`) - the words of the bank-transfer settlement alert,
 * shared by its hand-built HTML (`email-templates/admin-bank-transfer-settlement.ts`),
 * the `{{settlementFigureNote}}` token and the settle's own reasons. A sibling
 * of `email-message-notes.ts`, split by size, and like it imports nothing.
 */
/**
 * #3979 (`INV-PAY-125`): why the inbound settle kept a bank transfer's stored
 * figure instead of the cash its invoice collected. The settle's own refusals
 * (`CashSettlementRefusal`) are these plus the second instrument, which #3638's
 * alert reports instead.
 */
export type IbSettlementKeptReason =
  | "cash-incomplete"
  | "cash-zero"
  | "several-payments"
  | "refund-note-applied"
  | "folded-refund"
  | "several-primary-rows";

const IB_SETTLEMENT_KEPT_REASON_WORDING: Record<IbSettlementKeptReason, string> = {
  "cash-incomplete": "the amount paid could not be read exactly from Xero",
  "cash-zero": "Xero reported the invoice paid in cash but the amount paid came to nothing",
  "several-payments": "the invoice matched more than one payment in the app",
  "refund-note-applied":
    "a credit note worded as a refund is applied to the invoice, and the app counts it as refunded money",
  "folded-refund":
    "the payment already records money refunded before it was paid (an older credit note on the invoice)",
  "several-primary-rows": "the payment carries more than one unpaid bank-transfer record",
};

/**
 * #3979 — the paragraph of the bank-transfer settlement alert that says what
 * needs a person, shared by the hand-built HTML and the
 * `{{settlementFigureNote}}` token (#2268): the flat editable body has no
 * conditional syntax. Who corrects a recorded figure is named, because the app
 * has no screen for it (`INV-OPS`: a database correction).
 */
export function ibSettlementFigureParagraph(input: {
  keptReason: IbSettlementKeptReason | null;
  owed: "overpaid" | "underpaid" | null;
  hasSupplementaryInvoice: boolean;
}): string {
  const parts: string[] = [];
  if (input.keptReason) {
    parts.push(
      `Xero shows this booking's bank-transfer invoice paid, but the app kept the amount it had recorded instead of the cash, because ${IB_SETTLEMENT_KEPT_REASON_WORDING[input.keptReason]}.`,
    );
  }
  if (input.owed === "overpaid") {
    parts.push("The member paid more than the booking owes: refund or credit the difference.");
  } else if (input.owed === "underpaid") {
    parts.push(
      input.hasSupplementaryInvoice
        ? "The member paid less than the booking owes, by more than its supplementary invoice bills: collect the rest."
        : "The member paid less than the booking owes: collect the rest.",
    );
  }
  if (input.keptReason) {
    parts.push(
      "The app has no screen to correct a recorded bank payment. If the recorded amount is wrong, ask whoever looks after the club's booking system (the owner or a developer) to correct the payment's recorded and refunded amounts together; the settled-cash audit (pnpm run payments:audit-ib-settled-cash) lists every booking affected.",
    );
  }
  return parts.join(" ");
}
