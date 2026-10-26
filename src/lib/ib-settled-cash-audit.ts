/**
 * Read-only report of settled bank-transfer receipts whose recorded figures are
 * not what Xero's cash supports (#3979, `INV-PAY-125`).
 *
 * Before #3979 the inbound settle kept the figure an Internet Banking payment
 * and its PRIMARY row were born with, so a booking re-priced (or charged a
 * recorded fee) before its invoice was raised was settled at its old price:
 * the booking ledger's bank receipt, and every refund and credit cap reading
 * the payment, were wrong. #3979 records the cash for new settles; no row
 * already settled is changed (no automatic backfill). This lists them, so they
 * can be corrected with the evidence in front of whoever does it.
 *
 * For every payment with a captured Internet Banking PRIMARY row on a Xero
 * invoice, not settled by an officer by hand (`INV-PAY-001`):
 *
 *   recorded = the PRIMARY row's amount
 *   cash     = the payments Xero recorded against that invoice, as the inbound
 *              invoice sync stored them (`INVOICE_PAYMENT` links on the payment,
 *              less any Xero reports DELETED or VOIDED -
 *              `isRecordedBookingInvoicePayment`)
 *   folded   = the payment's refunded total less what its rows record: money
 *              counted as refunded that no refund row explains (an older credit
 *              note folded into it). Flagged on its own, because a receipt and
 *              its refunded total are corrected TOGETHER: either alone moves the
 *              payment's net. It also catches the deploy window, while the old
 *              and new code could count an invoice correction differently.
 *
 * Listed APART, never as a difference, because local data cannot say what the
 * cash was: a receipt whose invoice was paid by an applied overpayment or
 * prepayment (Xero records an allocation, not a payment; the inbound sync marks
 * the primary-invoice link, `PRIMARY_INVOICE_CASH_ALLOCATIONS_KEY`), one with no
 * payment record at all (settled before payments were linked), and one whose
 * payment amount cannot be read.
 *
 * REPORT ONLY - IT NEVER WRITES AND NEVER REPAIRS. It issues typed SELECTs
 * through Prisma (`INV-OPS-001`) and calls no provider. A correction is a
 * database change made by the owner or a developer under the raw-SQL rules
 * (`INV-OPS`), on the receipt and the refunded total together.
 */
import { PaymentSource, PaymentTransactionKind } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import {
  INVOICE_PAYMENT_ROLE,
  isRecordedBookingInvoicePayment,
  PRIMARY_INVOICE_CASH_ALLOCATIONS_KEY,
} from "@/lib/xero-inbound/object-links";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";

export type IbSettledCashEvidence =
  /** The invoice's recorded payments were read; `cashCents` is their sum. */
  | "payments"
  /** The invoice was paid, wholly or partly, by an applied overpayment or prepayment. */
  | "allocations"
  /** No payment against the invoice is recorded locally. */
  | "none"
  /** A recorded payment's amount could not be read. */
  | "unreadable";

export interface IbSettledCashRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceId: string;
  xeroInvoiceNumber: string | null;
  /** The captured PRIMARY row's figure - what the ledger's bank receipt posts. */
  recordedCents: number;
  /** `Payment.amountCents`, which refund and credit caps read. */
  paymentAmountCents: number;
  /** `Payment.refundedAmountCents`. */
  refundedAmountCents: number;
  /** What the payment's rows record as refunded. */
  rowsRefundedCents: number;
  evidence: IbSettledCashEvidence;
  /** The cash Xero recorded; null unless `evidence` is "payments". */
  cashCents: number | null;
}

export interface IbSettledCashAuditResult {
  /** Captured bank-transfer receipts read. */
  scanned: number;
  /** Receipts whose figure differs from the cash on record. */
  differences: IbSettledCashRow[];
  /** Payments whose refunded total exceeds what their rows record. */
  folded: IbSettledCashRow[];
  /** Receipts local data cannot judge. */
  unjudged: IbSettledCashRow[];
}

type PaymentLink = {
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  role: string | null;
  metadata: unknown;
};

/**
 * The cash recorded against one invoice from a payment's links: the sum of its
 * recorded payments, or why it cannot be summed.
 */
export function recordedInvoiceCash(
  links: readonly PaymentLink[],
  invoiceId: string,
): { evidence: IbSettledCashEvidence; cashCents: number | null } {
  const allocations = links.some(
    (link) =>
      link.xeroObjectType === "INVOICE" &&
      link.xeroObjectId === invoiceId &&
      link.role === "PRIMARY_INVOICE" &&
      (readNumber(asRecord(link.metadata)?.[PRIMARY_INVOICE_CASH_ALLOCATIONS_KEY]) ?? 0) > 0,
  );
  if (allocations) return { evidence: "allocations", cashCents: null };
  const recorded = links.filter(
    (link) =>
      link.role === INVOICE_PAYMENT_ROLE &&
      readString(asRecord(link.metadata)?.invoiceId) === invoiceId &&
      isRecordedBookingInvoicePayment(link),
  );
  if (recorded.length === 0) return { evidence: "none", cashCents: null };
  let cashCents = 0;
  for (const link of recorded) {
    const cents = providerAmountToCents(asRecord(link.metadata)?.amount);
    if (cents === null) return { evidence: "unreadable", cashCents: null };
    cashCents += cents;
  }
  return { evidence: "payments", cashCents };
}

export async function auditIbSettledCash(db: Pick<typeof prisma, "payment" | "xeroObjectLink"> = prisma): Promise<IbSettledCashAuditResult> {
  const capturedReceipt = {
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.INTERNET_BANKING,
    status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
    xeroInvoiceId: { not: null },
  };
  const payments = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      manuallyMarkedPaidAt: null,
      transactions: { some: capturedReceipt },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      refundedAmountCents: true,
      booking: { select: { status: true } },
      transactions: {
        select: {
          kind: true,
          source: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const links: PaymentLink[] =
    payments.length === 0
      ? []
      : await db.xeroObjectLink.findMany({
          where: {
            localModel: "Payment",
            localId: { in: payments.map((payment) => payment.id) },
            active: true,
            OR: [
              { xeroObjectType: "PAYMENT", role: INVOICE_PAYMENT_ROLE },
              { xeroObjectType: "INVOICE", role: "PRIMARY_INVOICE" },
            ],
          },
          select: { localId: true, xeroObjectType: true, xeroObjectId: true, role: true, metadata: true },
        });

  const result: IbSettledCashAuditResult = { scanned: 0, differences: [], folded: [], unjudged: [] };
  for (const payment of payments) {
    const rowsRefundedCents = payment.transactions.reduce((sum, row) => sum + row.refundedAmountCents, 0);
    const receipts = payment.transactions.filter(
      (row) =>
        row.kind === PaymentTransactionKind.PRIMARY &&
        row.source === PaymentSource.INTERNET_BANKING &&
        row.xeroInvoiceId !== null &&
        (CAPTURED_TRANSACTION_STATUS_LIST as readonly string[]).includes(row.status),
    );
    for (const receipt of receipts) {
      const invoiceId = receipt.xeroInvoiceId!;
      const paymentLinks = links.filter((link) => link.localId === payment.id);
      result.scanned += 1;
      const cash = recordedInvoiceCash(paymentLinks, invoiceId);
      const row: IbSettledCashRow = {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        bookingStatus: payment.booking.status,
        xeroInvoiceId: invoiceId,
        xeroInvoiceNumber: receipt.xeroInvoiceNumber,
        recordedCents: receipt.amountCents,
        paymentAmountCents: payment.amountCents,
        refundedAmountCents: payment.refundedAmountCents,
        rowsRefundedCents,
        evidence: cash.evidence,
        cashCents: cash.cashCents,
      };
      if (payment.refundedAmountCents > rowsRefundedCents) result.folded.push(row);
      if (cash.evidence !== "payments") result.unjudged.push(row);
      else if (cash.cashCents !== receipt.amountCents) result.differences.push(row);
    }
  }
  return result;
}

const CORRECTION_INSTRUCTION =
  "Correct a receipt and the payment's refunded total TOGETHER - either alone moves the payment's net. The app has no screen for it: it is a database correction made by the owner or a developer under the raw-SQL rules (INV-OPS). Check each invoice in Xero first.";

export function formatIbSettledCashReport(result: IbSettledCashAuditResult, format: ClubFormat): string {
  const money = (cents: number) => formatCents(cents, format);
  const describe = (row: IbSettledCashRow) =>
    `booking ${row.bookingId} (${row.bookingStatus}) payment ${row.paymentId} invoice ${row.xeroInvoiceNumber ?? row.xeroInvoiceId}`;
  const lines = [
    "Settled bank-transfer receipts against the cash Xero recorded (#3979, INV-PAY-125)",
    `  receipts read: ${result.scanned}`,
    `  recorded figure differs from the cash: ${result.differences.length}`,
    `  refunded total beyond what the rows record: ${result.folded.length}`,
    `  cannot be judged from local data: ${result.unjudged.length}`,
  ];
  if (result.differences.length > 0) {
    lines.push("", "Differences (recorded vs cash):");
    for (const row of result.differences) {
      lines.push(
        `  ${describe(row)}: recorded ${money(row.recordedCents)}, cash ${money(row.cashCents ?? 0)}, payment figure ${money(row.paymentAmountCents)}, refunded ${money(row.refundedAmountCents)}`,
      );
    }
  }
  if (result.folded.length > 0) {
    lines.push("", "Refunded total beyond the rows (an older credit note folded in):");
    for (const row of result.folded) {
      lines.push(
        `  ${describe(row)}: refunded ${money(row.refundedAmountCents)}, rows record ${money(row.rowsRefundedCents)}, recorded ${money(row.recordedCents)}`,
      );
    }
  }
  if (result.unjudged.length > 0) {
    lines.push("", "Not judged (check the invoice in Xero):");
    for (const row of result.unjudged) {
      const why =
        row.evidence === "allocations"
          ? "paid by an applied overpayment or prepayment, which leaves no payment record"
          : row.evidence === "none"
            ? "no payment recorded locally - settled before payments were linked"
            : "a recorded payment's amount cannot be read";
      lines.push(`  ${describe(row)}: recorded ${money(row.recordedCents)}; ${why}`);
    }
  }
  if (result.differences.length + result.folded.length > 0) lines.push("", CORRECTION_INSTRUCTION);
  return lines.join("\n");
}
