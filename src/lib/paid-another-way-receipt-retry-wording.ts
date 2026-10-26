/**
 * #3924 round 9 (`INV-PAY-122`): WHAT THE TREASURER IS TOLD TO DO when a late
 * card charge's Xero receipt reaches Xero only through an officer's retry -
 * the receipt row failed after it may already have reached Xero, which a close
 * never runs again (`keptReceiptHeldForOfficer`), or a change's invoice for the
 * charge failed (`invoiceFailed`). The close's refund note follows that retry.
 *
 * Round 10: a change's invoice that failed AFTER it attempted `createInvoices`
 * (`invoiceMayBeInXero`) is `held-for-officer` too, since a blind retry could
 * raise a second invoice; and a record found already in Xero is marked
 * resolved, with this refund recorded by hand, never retried. `followUp` says
 * what follows the retry, in the caller's words.
 *
 * Pure and client-safe: the one home of the instruction, read by the
 * stuck-states dialog's promise, the toast after the close, and the close's
 * audit summary (`INV-SSOT`).
 */
export type PaidAnotherWayReceiptRetry = "held-for-officer" | "failed";

export function paidAnotherWayReceiptRetryInstruction(kind: PaidAnotherWayReceiptRetry, followUp: string): string {
  return kind === "held-for-officer"
    ? `This late card charge's Xero record (its change invoice or its own receipt) failed and may already be in Xero, so check Xero first. If it is not there, retry it from the Xero operations list, and ${followUp}. If it is already in Xero, mark it resolved as fixed in Xero and record this refund by hand.`
    : `This late card charge's invoice failed before it reached Xero. Retry it from the Xero operations list, and ${followUp}.`;
}
