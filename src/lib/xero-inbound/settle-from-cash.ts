/**
 * SETTLE A BANK TRANSFER FROM THE CASH ITS INVOICE COLLECTED (#3979,
 * `INV-PAY-125`).
 *
 * When Xero reports a booking's PRIMARY invoice paid, the inbound settle
 * (`invoice-paid-effects.ts`) records the bank receipt. Before #3979 it kept the
 * figure the PRIMARY `PaymentTransaction` and `Payment.amountCents` were born
 * with, when the Internet Banking payment was first written. No edit path
 * rewrites either one, so an unpaid booking re-priced before its invoice was
 * raised was settled at its OLD price: the ledger's bank receipt was wrong, and
 * so was every refund and credit cap that reads the payment.
 *
 * Owner decision, 13 Oct 2026 (#3979): the receipt is the cash the paid invoice
 * actually collected (`quantifyXeroInvoiceCashCents`), not the amount the booking
 * owes. A price raised after the invoice is billed on a supplementary invoice,
 * which this invoice never collected, so the amount owed would overstate it.
 *
 * This module decides, from the rows the settle reads under its locks and the
 * paid invoice it already holds, whether that figure may be written. The settle
 * writes it; this module writes nothing and takes no lock. What the operators
 * are told lives in `settle-from-cash-notice.ts`.
 */
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import type { Invoice } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  deriveAggregatePaymentStatus,
  grossCapturedCents,
  isCapturedTransactionStatus,
  LEGACY_PRIMARY_BACKFILL_REASON,
} from "@/lib/payment-transaction-status";
import { readModificationNoteCash } from "@/lib/xero-inbound/account-credit-modification-notes";
import type { IbSettlementKeptReason } from "@/lib/ib-settlement-figure-note";

/** The paid invoice's cash, as `quantifyXeroInvoiceCashCents` measures it. */
export type InvoiceCash = { knownCents: number; complete: boolean };

/**
 * The `reason` on a bank-transfer PRIMARY receipt the settle recorded at the
 * invoice's cash. The refunded-total repair reads it (`INV-PAY-126`): an invoice
 * correction counts as refunded only against a receipt recorded at the stored
 * figure (before #3979, or kept), never against one recorded from cash.
 */
export const IB_RECEIPT_FROM_CASH_REASON = "xero_invoice_paid_cash";

/**
 * The reasons a bank-transfer PRIMARY receipt carries when it holds the figure
 * the payment was BORN with, not cash read from Xero: the payment's creation
 * (`booking-create.ts`, the switch to bank transfer), the settle before #3979 or
 * when it keeps the stored figure (`xero_invoice_paid_reconciliation`), the
 * legacy backfill, and none. An explicit allowlist (#3979 final review): any
 * other reason - the cash marker above, a part payment recognised at cancel
 * (`PART_PAYMENT_RECOGNISED_REASON`), an officer's cash - is cash-sized.
 */
const STORED_FIGURE_RECEIPT_REASONS: ReadonlySet<string | null> = new Set([
  null,
  "internet_banking_booking_payment",
  "internet_banking_switch_at_pay",
  "xero_invoice_paid_reconciliation",
  LEGACY_PRIMARY_BACKFILL_REASON,
]);

/**
 * #3979 (`INV-PAY-126`): whether an invoice correction still counts as refunded
 * against this payment - a bank-transfer PRIMARY receipt is captured, and every
 * captured one holds the stored figure (`STORED_FIGURE_RECEIPT_REASONS`). Such a
 * receipt is the figure the payment was born with (settled before #3979, or
 * kept by the settle), so it still includes the corrected amount, and counting
 * the correction keeps the payment's net at the cash. A payment never
 * captured, or with a cash-sized receipt, never counts one. Pure, over the
 * payment's rows: the refunded-total repair and the Xero repair tool both read it.
 */
export function receiptCountsInvoiceCorrections(
  rows: ReadonlyArray<{ kind: PaymentTransactionKind; source: PaymentSource; status: PaymentStatus; reason: string | null }>,
): boolean {
  const receipts = rows.filter((row) => isInternetBankingPrimary(row) && isCapturedTransactionStatus(row.status));
  return receipts.length > 0 && receipts.every((row) => STORED_FIGURE_RECEIPT_REASONS.has(row.reason));
}

/**
 * Why a settle kept the stored figure instead of the invoice's cash: the
 * reasons its alert words (`IbSettlementKeptReason`, with that wording), and a
 * second instrument (#3638), whose own alert speaks for it.
 *
 * - `refund-note-applied`: a modification credit note worded as a refund is
 *   applied to the invoice; the note sync counts it as refunded whenever it
 *   runs, so writing the cash (which already leaves it out) would count the
 *   reduction twice.
 * - `folded-refund`: the refunded total holds money no row records (an older
 *   note folded into it) that the invoice's no-cash notes do not exactly explain.
 */
export type CashSettlementRefusal = IbSettlementKeptReason | "second-instrument";

export type CashSettlementPlan =
  /** The PRIMARY receipt was already captured: a replay, which decides no amount again. */
  | { kind: "replay" }
  /**
   * The receipt is the cash. The payment's columns are what
   * `reconcilePaymentAggregates` projects from the same rows with the receipt
   * captured at the cash: its figure the cash plus whatever else is captured on
   * it (a card capture refunded before the switch, #1765), its refunded total
   * the rows' own (an older correction folded into it, exactly explained by the
   * invoice's no-cash notes, comes off), and its status from both.
   */
  | {
      kind: "rewrite";
      receiptCents: number;
      paymentAmountCents: number;
      refundedAmountCents: number;
      status: PaymentStatus;
    }
  | { kind: "keep"; reason: CashSettlementRefusal };

export type CashSettlementTransaction = {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
};

function isInternetBankingPrimary(row: Pick<CashSettlementTransaction, "kind" | "source">): boolean {
  return row.kind === PaymentTransactionKind.PRIMARY && row.source === PaymentSource.INTERNET_BANKING;
}

/**
 * The one decision (`INV-PAY-125`). It is taken only at the TRANSITION, while
 * no Internet Banking PRIMARY row of the payment is captured; a replay keeps
 * whatever the first settle wrote. The cash is written only when it is a
 * complete, positive figure that belongs to this payment alone: exactly one
 * matched payment, no refund-worded modification note applied to the invoice,
 * no folded refund the invoice's no-cash notes do not exactly explain, at most
 * one uncaptured Internet Banking PRIMARY row, and no second instrument.
 */
export function planInternetBankingCashSettlement(input: {
  refundedAmountCents: number;
  transactions: readonly CashSettlementTransaction[];
  cash: InvoiceCash;
  matchedPayments: number;
  secondInstrument: boolean;
  /** Modification notes applied to the invoice: worded as refunds, and moving no cash. */
  appliedNotes: { refundWordedCents: number; noCashCents: number };
}): CashSettlementPlan {
  const primaryRows = input.transactions.filter(isInternetBankingPrimary);
  if (primaryRows.some((row) => isCapturedTransactionStatus(row.status))) {
    return { kind: "replay" };
  }
  if (input.secondInstrument) return { kind: "keep", reason: "second-instrument" };
  if (!input.cash.complete) return { kind: "keep", reason: "cash-incomplete" };
  if (input.cash.knownCents <= 0) return { kind: "keep", reason: "cash-zero" };
  if (input.matchedPayments !== 1) return { kind: "keep", reason: "several-payments" };
  if (input.appliedNotes.refundWordedCents > 0) return { kind: "keep", reason: "refund-note-applied" };
  const ledgerRefundedCents = input.transactions.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  const foldedCents = input.refundedAmountCents - ledgerRefundedCents;
  if (foldedCents > 0 && foldedCents !== input.appliedNotes.noCashCents) {
    return { kind: "keep", reason: "folded-refund" };
  }
  if (primaryRows.length > 1) return { kind: "keep", reason: "several-primary-rows" };
  const paymentAmountCents =
    input.cash.knownCents + grossCapturedCents(input.transactions.filter((row) => !isInternetBankingPrimary(row)));
  return {
    kind: "rewrite",
    receiptCents: input.cash.knownCents,
    paymentAmountCents,
    refundedAmountCents: ledgerRefundedCents,
    status: deriveAggregatePaymentStatus(
      PaymentStatus.SUCCEEDED,
      paymentAmountCents,
      ledgerRefundedCents,
      PaymentStatus.SUCCEEDED,
    ),
  };
}

/** A credit note Xero lists as applied to the paid invoice. */
export type AppliedCreditNote = { id: string; appliedCents: number };

/** What the paid invoice says, beyond its cash. */
export type PaidInvoiceFacts = {
  /** The invoice's total, or null when the payload carries none. */
  totalCents: number | null;
  appliedCreditNotes: readonly AppliedCreditNote[];
};

/** The paid invoice's total and the credit notes it lists as applied, in cents. */
export function paidInvoiceFacts(invoice: Pick<Invoice, "total" | "creditNotes">): PaidInvoiceFacts {
  return {
    totalCents: providerAmountToCents(invoice.total),
    appliedCreditNotes: (invoice.creditNotes ?? []).flatMap((note) => {
      const appliedCents = providerAmountToCents(note.appliedAmount);
      return note.creditNoteID && appliedCents !== null && appliedCents > 0
        ? [{ id: note.creditNoteID, appliedCents }]
        : [];
    }),
  };
}

/**
 * The settle's one call, inside its locked transaction after both fences
 * (`INV-PAY-125`): the payment's rows, the plan, the receipt and the payment's
 * columns to write, and the invoice-side figure the cancel arms report a mixed
 * invoice against.
 */
export async function decideInternetBankingReceiptFigure(
  tx: Prisma.TransactionClient,
  input: {
    payment: { id: string; amountCents: number; refundedAmountCents: number };
    cash: InvoiceCash;
    matchedPayments: number;
    secondInstrument: boolean;
    invoice: PaidInvoiceFacts;
  },
): Promise<{
  plan: CashSettlementPlan;
  /** The receipt's figure: the cash, or the stored receipt's when kept. */
  receiptCents: number;
  /** What the PRIMARY row update adds: the cash marker, and the amount where it differs. */
  primaryRowWrite: { amountCents?: number; reason?: string };
  /** The payment's columns when the plan rewrote them, else null. */
  paymentColumns: { amountCents: number; refundedAmountCents: number; status: PaymentStatus } | null;
  /**
   * The cash the invoice expected - its total less the member's own account
   * credit applied to it - when the cash came short of it: the rest was cleared
   * some other way (a write-off, a clearing note) and an operator should know
   * (#1459). Null when the cash covers it.
   */
  mixedInvoiceExpectedCents: number | null;
}> {
  const { payment } = input;
  const rows = await tx.paymentTransaction.findMany({
    where: { paymentId: payment.id },
    select: { kind: true, source: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  const noteIds = input.invoice.appliedCreditNotes.map((note) => note.id);
  const [noteCash, memberCreditNotes] =
    noteIds.length === 0
      ? [new Map(), new Set<string>()]
      : await Promise.all([
          readModificationNoteCash(noteIds, tx),
          tx.memberCredit
            .findMany({ where: { xeroCreditNoteId: { in: noteIds } }, select: { xeroCreditNoteId: true } })
            .then((credits) => new Set(credits.map((credit) => credit.xeroCreditNoteId))),
        ]);
  let refundWordedCents = 0;
  let noCashCents = 0;
  let memberCreditCents = 0;
  for (const note of input.invoice.appliedCreditNotes) {
    // The member's own account credit first (#3979 final review): an edit's
    // credit kept as account credit on ANOTHER booking is a modification
    // account-credit note, but applied here it is this booking's credit.
    if (memberCreditNotes.has(note.id)) {
      memberCreditCents += note.appliedCents;
      continue;
    }
    const kind = noteCash.get(note.id);
    if (kind === "refund") refundWordedCents += note.appliedCents;
    else if (kind) noCashCents += note.appliedCents;
  }

  const plan = planInternetBankingCashSettlement({
    refundedAmountCents: payment.refundedAmountCents,
    transactions: rows,
    cash: input.cash,
    matchedPayments: input.matchedPayments,
    secondInstrument: input.secondInstrument,
    appliedNotes: { refundWordedCents, noCashCents },
  });
  const uncapturedPrimary = rows.filter(
    (row) => isInternetBankingPrimary(row) && !isCapturedTransactionStatus(row.status),
  );
  const [onlyUncapturedPrimary, ...moreUncapturedPrimary] = uncapturedPrimary;
  const storedReceiptCents =
    onlyUncapturedPrimary && moreUncapturedPrimary.length === 0 ? onlyUncapturedPrimary.amountCents : payment.amountCents;
  const receiptCents = plan.kind === "rewrite" ? plan.receiptCents : storedReceiptCents;

  const expectedCents =
    input.invoice.totalCents !== null ? input.invoice.totalCents - memberCreditCents : storedReceiptCents;
  // Only cash that quantified to something can be "part" of the invoice; a
  // figure that read as nothing is the unquantifiable fallback, not a mix.
  const mixedInvoiceExpectedCents =
    input.cash.knownCents > 0 && input.cash.knownCents < expectedCents ? expectedCents : null;

  if (plan.kind !== "rewrite") {
    return { plan, receiptCents, primaryRowWrite: {}, paymentColumns: null, mixedInvoiceExpectedCents };
  }
  const primaryDiffers = uncapturedPrimary.some((row) => row.amountCents !== plan.receiptCents);
  return {
    plan,
    receiptCents,
    primaryRowWrite: {
      reason: IB_RECEIPT_FROM_CASH_REASON,
      ...(primaryDiffers ? { amountCents: plan.receiptCents } : {}),
    },
    paymentColumns: {
      amountCents: plan.paymentAmountCents,
      refundedAmountCents: plan.refundedAmountCents,
      status: plan.status,
    },
    mixedInvoiceExpectedCents,
  };
}
