import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { asRecord, readString } from "@/lib/xero-json";

/** Request-local observations, never a booking balance or a settlement writer. */
export type InvoicePayableObservation = {
  invoiceId: string;
  observedAt: string;
} & (
  | { kind: "payable"; invoiceNumber: string; reference: string | null; dueCents: number }
  | { kind: "settled"; invoiceNumber: string }
  | { kind: "retired"; invoiceNumber: string; status: "VOIDED" | "DELETED" }
  | { kind: "unknown" }
);

/** The native JSON boundary uses Xero's PascalCase fields exactly once. */
export function observeInvoicePayables(
  response: unknown,
  invoiceIds: readonly string[],
  currencyCode: string,
  observedAt: string,
): InvoicePayableObservation[] {
  const unknown = (invoiceId: string): InvoicePayableObservation => ({ kind: "unknown", invoiceId, observedAt });
  const rows = asRecord(response)?.Invoices;
  if (!Array.isArray(rows)) return invoiceIds.map(unknown);
  const requested = new Set(invoiceIds);
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of rows) {
    const row = asRecord(value);
    const id = readString(row?.InvoiceID);
    // INV-SSOT-001: one coverage boundary; no caller treats omissions as zero.
    if (!row || !id || !requested.has(id) || byId.has(id)) return invoiceIds.map(unknown);
    byId.set(id, row);
  }
  return invoiceIds.map((invoiceId): InvoicePayableObservation => {
    const row = byId.get(invoiceId);
    const invoiceNumber = readString(row?.InvoiceNumber);
    if (!row || !invoiceNumber || row.Type !== "ACCREC" || row.CurrencyCode !== currencyCode) return unknown(invoiceId);
    if (row.Status === "VOIDED" || row.Status === "DELETED") {
      return { kind: "retired", invoiceId, invoiceNumber, status: row.Status, observedAt };
    }
    const rawDue = row.AmountDue;
    // INV-MONEY-001/003: rounding never turns a positive provider balance into settlement.
    if (typeof rawDue !== "number" || !Number.isFinite(rawDue) || rawDue < 0) return unknown(invoiceId);
    const dueCents = exactProviderAmountToCents(rawDue);
    if (dueCents === null || !Number.isSafeInteger(dueCents) || dueCents < 0) return unknown(invoiceId);
    if ((row.Status === "AUTHORISED" || row.Status === "PAID") && rawDue === 0) {
      return { kind: "settled", invoiceId, invoiceNumber, observedAt };
    }
    if (row.Status !== "AUTHORISED" || dueCents <= 0) return unknown(invoiceId);
    return { kind: "payable", invoiceId, invoiceNumber, reference: readString(row.Reference), dueCents, observedAt };
  });
}
