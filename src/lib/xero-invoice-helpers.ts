/**
 * Shared helpers for the Xero booking-invoice flows.
 *
 * Tiny utilities used across `xero-booking-invoices`, `xero-credit-notes`,
 * `xero-invoice-payments`, `xero-supplementary-invoices`,
 * `xero-modification-credit-notes`, and `xero-entrance-fee-invoices`.
 * Kept in their own module so the consumers do not have to import each
 * other just for date / allocation helpers.
 */

import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function getBookingInvoiceIssueDate(booking: {
  checkIn: Date | string;
}): string {
  return formatDate(new Date(booking.checkIn));
}

export function getBookingInvoiceDueDate(booking: {
  createdAt: Date | string;
}): string {
  return formatDate(new Date(booking.createdAt));
}

/**
 * Construct a stable allocation identifier for a Xero credit-note
 * allocation. Xero does not return per-allocation IDs, so the local code
 * derives one from the credit note, invoice, and amount.
 */
export function buildSyntheticAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}
