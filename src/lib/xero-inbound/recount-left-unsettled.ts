import { notifyXeroSyncError } from "@/lib/xero-error-alert";

/**
 * #4095: a reconcile that wrote everything it could but left a refunded-total
 * recount unwritten (a claim lost twice, or a kept settle's recount that
 * failed) says so in its result, and its caller fails on it here, after those
 * writes. A stored inbound event is retried after its backoff, so the retry
 * recounts. The incremental invoice reconciliation is never retried - the
 * membership cursor has moved past the invoice - so it reports the invoice
 * failed and alerts a person first (`runIncrementalInvoiceReconciliation`).
 * Its own module so both callers share it without an import cycle between
 * `event-processing.ts` and `invoice.ts`.
 */
export function failIfRecountLeftUnsettled<T extends { recountLeftUnsettled?: string }>(result: T): T {
  if (result.recountLeftUnsettled) throw new Error(result.recountLeftUnsettled);
  return result;
}

export type UnrecountedInvoice = { invoiceId: string; message: string };

/**
 * #4095 (PR #4437 review round 3, L1): one alert for every invoice a run left
 * unrecounted. `notifyXeroSyncError` sends at most one alert an hour across
 * every Xero error, so an alert per invoice would silently drop all but the
 * first; one alert naming them all reaches a person whole.
 */
export async function alertUnrecountedInvoices(unrecounted: UnrecountedInvoice[]): Promise<void> {
  if (unrecounted.length === 0) return;
  await notifyXeroSyncError({
    errorType: "refund-ledger-divergence",
    operation: `incremental-invoice-reconciliation:recount:${unrecounted.map((entry) => entry.invoiceId).join(",")}`,
    errorMessage: `${unrecounted.map((entry) => entry.message).join(" ")} Nothing retries ${unrecounted.length === 1 ? "it" : "them"} on its own; check each payment's refunded total against Xero.`,
  });
}
