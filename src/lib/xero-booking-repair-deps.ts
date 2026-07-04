// Injectable dependency table for the booking-vs-Xero repair tool. Extracted
// verbatim from xero-booking-repair.ts (#1208 item 2). Imports each source
// domain module directly, never the @/lib/xero facade (#1208).
import {
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
} from "@/lib/stripe";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";
import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
} from "@/lib/xero-operation-queue";
import { prisma } from "@/lib/prisma";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";

export type RepairDependencies = {
  prisma: typeof prisma;
  enqueueXeroBookingInvoiceOperation: typeof enqueueXeroBookingInvoiceOperation;
  enqueueXeroBookingInvoiceUpdateOperation: typeof enqueueXeroBookingInvoiceUpdateOperation;
  enqueueXeroSupplementaryInvoiceOperation: typeof enqueueXeroSupplementaryInvoiceOperation;
  enqueueXeroModificationCreditNoteOperation: typeof enqueueXeroModificationCreditNoteOperation;
  enqueueXeroAccountCreditNoteOperation: typeof enqueueXeroAccountCreditNoteOperation;
  enqueueXeroRefundCreditNoteOperation: typeof enqueueXeroRefundCreditNoteOperation;
  enqueueXeroCreditNoteAllocationOperation: typeof enqueueXeroCreditNoteAllocationOperation;
  enqueueXeroSyncOperationRetry: typeof enqueueXeroSyncOperationRetry;
  processQueuedXeroOutboxOperations: typeof processQueuedXeroOutboxOperations;
  processQueuedXeroOperationRetries: typeof processQueuedXeroOperationRetries;
  upsertXeroObjectLink: typeof upsertXeroObjectLink;
  isXeroConnected: typeof isXeroConnected;
  cancelPaymentIntentIfCancellable: typeof cancelPaymentIntentIfCancellable;
  getPaymentIntent: typeof getPaymentIntent;
  markPaymentIntentTransactionFailed: typeof markPaymentIntentTransactionFailed;
  refundPaymentTransactions: typeof refundPaymentTransactions;
};

const defaultDependencies: RepairDependencies = {
  prisma,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOutboxOperations,
  processQueuedXeroOperationRetries,
  upsertXeroObjectLink,
  isXeroConnected,
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
};

export function getDependencies(overrides?: Partial<RepairDependencies>): RepairDependencies {
  return {
    ...defaultDependencies,
    ...overrides,
  };
}
