import { Prisma } from "@prisma/client";
import { XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE } from "./xero-operation-outbox-payload";

/**
 * A claimed applied-credit worker found another claimed operation for the same
 * Payment. The outbox treats this as transient contention and returns this
 * operation to PENDING instead of creating a durable FAILED dead-end.
 */
export class XeroAppliedCreditOperationBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroAppliedCreditOperationBusyError";
  }
}

export function isXeroAppliedCreditOperationBusyError(
  error: unknown
): error is XeroAppliedCreditOperationBusyError {
  return error instanceof XeroAppliedCreditOperationBusyError;
}

/**
 * A cancel/expiry transition must not freeze its Xero clearing amount while a
 * queued deallocation still represents a newer local applied-credit target.
 * FAILED/PARTIAL remain blocking because provider and local slice state may
 * have diverged; an operator must retry the operation to COMPLETE it first.
 */
export async function findUnconvergedAppliedCreditDeallocation(
  paymentId: string,
  db: Prisma.TransactionClient,
): Promise<{ id: string; status: string } | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
      status: {
        in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
      },
    },
    select: { id: true, status: true },
  });
}
