// Repair-payment transaction derivation (ledger + legacy fallback) for the
// booking-vs-Xero repair tool. Extracted verbatim from xero-booking-repair.ts
// (#1208 item 2). Money stays in integer cents.
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import type { BookingPaymentRecord } from "./xero-booking-repair-types";

interface RepairPaymentTransaction {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  createdAt: Date;
}

const CAPTURED_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

const CANCELLABLE_REPAIR_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
]);

function isCapturedRepairPaymentStatus(status: PaymentStatus) {
  return CAPTURED_REPAIR_PAYMENT_STATUSES.has(status);
}

function mapLegacyAdditionalPaymentStatus(
  status: string | null | undefined
): PaymentStatus {
  switch (status) {
    case "FAILED":
      return PaymentStatus.FAILED;
    case "SUCCEEDED":
      return PaymentStatus.SUCCEEDED;
    case "PROCESSING":
      return PaymentStatus.PROCESSING;
    case "PENDING":
    default:
      return PaymentStatus.PENDING;
  }
}

// The repair pass's legacy-fallback status synthesis: when a payment has no
// ledger rows, its captured/refunded state is derived from the aggregate
// refund mirror (#1208 item 2). Exported so the #1506 cancel-flatten backfill
// restores the exact captured status this read path already synthesizes,
// rather than duplicating the derivation.
export function applyLegacyRefundStatus(
  baseStatus: PaymentStatus,
  amountCents: number,
  refundedAmountCents: number
) {
  if (amountCents > 0 && refundedAmountCents >= amountCents) {
    return PaymentStatus.REFUNDED;
  }

  if (refundedAmountCents > 0) {
    return PaymentStatus.PARTIALLY_REFUNDED;
  }

  return baseStatus;
}

function buildRepairPaymentTransactions(
  payment: BookingPaymentRecord | null | undefined
): RepairPaymentTransaction[] {
  if (!payment) {
    return [];
  }

  const ledgerTransactions = (payment.transactions ?? []).map(
    (transaction): RepairPaymentTransaction => ({
      kind: transaction.kind,
      source: transaction.source,
      stripePaymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      refundedAmountCents: transaction.refundedAmountCents,
      status: transaction.status,
      createdAt: transaction.createdAt,
    })
  );

  if (ledgerTransactions.length > 0) {
    return ledgerTransactions;
  }

  const legacyTransactions: RepairPaymentTransaction[] = [];
  const additionalStatus = mapLegacyAdditionalPaymentStatus(
    payment.additionalPaymentStatus
  );
  const additionalCapturedAmountCents =
    payment.additionalPaymentIntentId &&
    additionalStatus === PaymentStatus.SUCCEEDED
      ? payment.additionalAmountCents
      : 0;
  const primaryAmountCents = payment.stripePaymentIntentId
    ? Math.max(payment.amountCents - additionalCapturedAmountCents, 0)
    : payment.amountCents;
  const additionalRefundedAmountCents =
    payment.additionalPaymentIntentId &&
    additionalStatus === PaymentStatus.SUCCEEDED
      ? Math.min(
          Math.max(payment.refundedAmountCents - primaryAmountCents, 0),
          payment.additionalAmountCents
        )
      : 0;
  const primaryRefundedAmountCents = payment.stripePaymentIntentId
    ? Math.min(
        Math.max(payment.refundedAmountCents - additionalRefundedAmountCents, 0),
        primaryAmountCents
      )
    : 0;

  if (payment.stripePaymentIntentId) {
    legacyTransactions.push({
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      amountCents: primaryAmountCents,
      refundedAmountCents: primaryRefundedAmountCents,
      status: applyLegacyRefundStatus(
        payment.status,
        primaryAmountCents,
        primaryRefundedAmountCents
      ),
      createdAt: payment.createdAt,
    });
  }

  if (payment.additionalPaymentIntentId) {
    legacyTransactions.push({
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: payment.additionalPaymentIntentId,
      amountCents: payment.additionalAmountCents,
      refundedAmountCents: additionalRefundedAmountCents,
      status: applyLegacyRefundStatus(
        additionalStatus,
        payment.additionalAmountCents,
        additionalRefundedAmountCents
      ),
      createdAt:
        payment.updatedAt.getTime() >= payment.createdAt.getTime()
          ? payment.updatedAt
          : payment.createdAt,
    });
  }

  return legacyTransactions;
}

function isStripeRepairPaymentTransaction(
  transaction: RepairPaymentTransaction
): transaction is RepairPaymentTransaction & {
  source: typeof PaymentSource.STRIPE;
  stripePaymentIntentId: string;
} {
  return (
    transaction.source === PaymentSource.STRIPE &&
    Boolean(transaction.stripePaymentIntentId)
  );
}

export function getOutstandingRepairTransactions(
  payment: BookingPaymentRecord | null | undefined
) {
  return buildRepairPaymentTransactions(payment)
    .filter(isStripeRepairPaymentTransaction)
    .filter((transaction) =>
      CANCELLABLE_REPAIR_PAYMENT_STATUSES.has(transaction.status)
    );
}

export function getCapturedRepairTransactions(
  payment: BookingPaymentRecord | null | undefined
) {
  return buildRepairPaymentTransactions(payment)
    .filter(isStripeRepairPaymentTransaction)
    .filter((transaction) => isCapturedRepairPaymentStatus(transaction.status));
}

export function getOutstandingCapturedRefundAmountCents(
  payment: BookingPaymentRecord | null | undefined
) {
  return getCapturedRepairTransactions(payment).reduce((sum, transaction) => {
    return sum + Math.max(transaction.amountCents - transaction.refundedAmountCents, 0);
  }, 0);
}
