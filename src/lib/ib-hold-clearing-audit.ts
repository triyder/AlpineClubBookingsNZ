/**
 * Read-only audit for Internet-Banking hold-expiry invoice-clearing that was
 * under-sized before #1597.
 *
 * Before #1597, `releaseOneHold` (internet-banking-payment-cron.ts) sized the
 * invoice-clearing credit note at `payment.amountCents` — the credit-REDUCED
 * effectivePriceCents — while the booking invoice is raised at the FULL
 * finalPriceCents. Where a released hold carried an issued invoice AND applied
 * credit, the invoice was left open by exactly the applied-credit slice.
 *
 * This module reports those bookings using ONLY local data (no Xero calls). It
 * mirrors the corrected #1597 runtime formula so the operator can reconcile the
 * expected-vs-actual clearing amounts without re-deriving anything. It never
 * writes and never touches a live provider — the operator applies any repair by
 * hand (see docs/MAINTENANCE.md; the existing xero-booking-repair CLI cannot
 * express this remainder repair — see the note there).
 */
import { CreditType, PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface IbHoldClearingRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  /** What the pre-#1597 release sized the clearing note at (payment.amountCents,
   * frozen once the hold released, so it is the definitive local record). */
  enqueuedClearingCents: number;
  changeFeeCents: number;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  xeroRefundCreditNoteId: string | null;
  finalPriceCents: number;
  /** Sum of BOOKING_APPLIED MemberCredit rows for the booking that carry a
   * xeroCreditNoteId (stored negative; 0 when none). */
  xeroAllocatedCreditSumCents: number;
}

export interface UnderClearedIbHoldFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  /** xeroInvoiceNumber when present, else the raw xeroInvoiceId. */
  invoiceRef: string;
  /** Whether a refund credit note actually landed in Xero for the payment; a
   * false here on an under-cleared row means the invoice may be fully open. */
  refundNoteIssued: boolean;
  finalPriceCents: number;
  changeFeeCents: number;
  xeroAllocatedAppliedCreditCents: number;
  /** max(0, finalPrice + changeFee − Xero-allocated applied credit) — the #1597
   * runtime sizing. */
  expectedClearingCents: number;
  /** What the pre-fix release actually enqueued. */
  enqueuedClearingCents: number;
  /** expected − enqueued; always > 0 for a finding. */
  deltaCents: number;
}

export interface IbHoldClearingAuditResult {
  scannedReleasedHolds: number;
  invoiceBearingHolds: number;
  /** Released holds with NO issued invoice (the create-time hold-slots shape).
   * Pre-#1597 these enqueued a refund note the worker could not process
   * ("No Xero invoice linked to payment"); post-fix they enqueue nothing.
   * Reported for visibility, not as under-cleared invoices. */
  noInvoiceReleasedHolds: number;
  underCleared: UnderClearedIbHoldFinding[];
  totalDeltaCents: number;
}

/**
 * Pure per-row sizing, mirroring the #1597 runtime formula exactly. Returns a
 * finding only for a hold that carried an issued invoice and whose clearing note
 * was under-sized (delta > 0); otherwise null.
 */
export function deriveIbHoldClearingFinding(
  row: IbHoldClearingRow,
): UnderClearedIbHoldFinding | null {
  // No issued invoice: nothing was (or should be) cleared. Surfaced separately.
  if (!row.xeroInvoiceId) {
    return null;
  }

  const xeroAllocatedAppliedCreditCents = Math.max(
    0,
    -row.xeroAllocatedCreditSumCents,
  );
  const expectedClearingCents = Math.max(
    0,
    row.finalPriceCents + row.changeFeeCents - xeroAllocatedAppliedCreditCents,
  );
  const deltaCents = expectedClearingCents - row.enqueuedClearingCents;
  if (deltaCents <= 0) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    invoiceRef: row.xeroInvoiceNumber ?? row.xeroInvoiceId,
    refundNoteIssued: Boolean(row.xeroRefundCreditNoteId),
    finalPriceCents: row.finalPriceCents,
    changeFeeCents: row.changeFeeCents,
    xeroAllocatedAppliedCreditCents,
    expectedClearingCents,
    enqueuedClearingCents: row.enqueuedClearingCents,
    deltaCents,
  };
}

/**
 * Scan every released Internet-Banking hold and report the ones whose
 * invoice-clearing note was under-sized. Read-only: it issues only SELECTs.
 */
export async function auditIbHoldClearingUnderclears(options?: {
  db?: typeof prisma;
}): Promise<IbHoldClearingAuditResult> {
  const db = options?.db ?? prisma;

  const released = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      internetBankingHoldSlots: true,
      internetBankingHoldReleasedAt: { not: null },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      changeFeeCents: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      xeroRefundCreditNoteId: true,
      booking: { select: { finalPriceCents: true, status: true } },
    },
    orderBy: { internetBankingHoldReleasedAt: "asc" },
  });

  const result: IbHoldClearingAuditResult = {
    scannedReleasedHolds: released.length,
    invoiceBearingHolds: 0,
    noInvoiceReleasedHolds: 0,
    underCleared: [],
    totalDeltaCents: 0,
  };

  for (const payment of released) {
    if (!payment.xeroInvoiceId) {
      result.noInvoiceReleasedHolds += 1;
      continue;
    }
    result.invoiceBearingHolds += 1;

    const aggregate = await db.memberCredit.aggregate({
      where: {
        appliedToBookingId: payment.bookingId,
        type: CreditType.BOOKING_APPLIED,
        xeroCreditNoteId: { not: null },
      },
      _sum: { amountCents: true },
    });

    const finding = deriveIbHoldClearingFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      enqueuedClearingCents: payment.amountCents,
      changeFeeCents: payment.changeFeeCents,
      xeroInvoiceId: payment.xeroInvoiceId,
      xeroInvoiceNumber: payment.xeroInvoiceNumber,
      xeroRefundCreditNoteId: payment.xeroRefundCreditNoteId,
      finalPriceCents: payment.booking.finalPriceCents,
      xeroAllocatedCreditSumCents: aggregate._sum.amountCents ?? 0,
    });

    if (finding) {
      result.underCleared.push(finding);
      result.totalDeltaCents += finding.deltaCents;
    }
  }

  return result;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}NZ$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatIbHoldClearingAuditReport(
  result: IbHoldClearingAuditResult,
): string {
  const lines: string[] = [];
  lines.push("Internet-Banking hold-expiry invoice-clearing audit (#1597)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("");
  lines.push(`Released holds scanned:        ${result.scannedReleasedHolds}`);
  lines.push(`  with an issued invoice:      ${result.invoiceBearingHolds}`);
  lines.push(`  with no invoice (skipped):   ${result.noInvoiceReleasedHolds}`);
  lines.push(`Under-cleared invoices found:  ${result.underCleared.length}`);
  lines.push(`Total open delta:              ${formatCents(result.totalDeltaCents)}`);
  lines.push("");

  if (result.underCleared.length === 0) {
    lines.push("No under-cleared invoices. Nothing to repair.");
    return lines.join("\n");
  }

  lines.push(
    "Each row's invoice was cleared by less than its true outstanding. The",
  );
  lines.push(
    "operator must issue a supplementary clearing credit note for exactly the",
  );
  lines.push(
    "delta by hand (see docs/MAINTENANCE.md) — do NOT run xero-booking-repair",
  );
  lines.push(
    "--apply on these: it would size a FULL clearing note and over-allocate.",
  );
  lines.push("");

  for (const finding of result.underCleared) {
    lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
    lines.push(`    booking status:   ${finding.bookingStatus}`);
    lines.push(`    invoice:          ${finding.invoiceRef}`);
    lines.push(`    refund note issued: ${finding.refundNoteIssued ? "yes" : "no"}`);
    lines.push(`    final price:      ${formatCents(finding.finalPriceCents)}`);
    lines.push(`    change fee:       ${formatCents(finding.changeFeeCents)}`);
    lines.push(
      `    Xero-allocated credit: ${formatCents(finding.xeroAllocatedAppliedCreditCents)}`,
    );
    lines.push(`    expected clearing: ${formatCents(finding.expectedClearingCents)}`);
    lines.push(`    actual clearing:   ${formatCents(finding.enqueuedClearingCents)}`);
    lines.push(`    OPEN DELTA:        ${formatCents(finding.deltaCents)}`);
  }

  return lines.join("\n");
}
