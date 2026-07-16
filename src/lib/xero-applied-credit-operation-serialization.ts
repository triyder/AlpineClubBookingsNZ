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

/**
 * Provider work is deliberately outside the member-ledger transaction. Once a
 * deallocation is RUNNING, or has failed after possibly changing Xero, local
 * writers must stop until that operation converges. Call this only while the
 * caller holds the member-credit ledger lock; that makes the worker's snapshot
 * and every competing mutation strictly ordered.
 *
 * A fresh PENDING row fences ordinary ledger writers because it represents a
 * clamp target that inbound provider truth must not undo. The allocation and
 * deallocation workers may explicitly allow an uncheckpointed PENDING row to
 * preserve queue ordering; checkpointed retries always remain fences.
 */
export async function findAppliedCreditDeallocationFence(
  paymentId: string,
  db: Prisma.TransactionClient,
  options?: {
    excludeOperationId?: string;
    allowUncheckpointedPending?: boolean;
  },
): Promise<{ id: string; status: string } | null> {
  const candidates = await db.xeroSyncOperation.findMany({
    where: {
      ...(options?.excludeOperationId
        ? { id: { not: options.excludeOperationId } }
        : {}),
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
      status: {
        in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
      },
    },
    select: { id: true, status: true, requestPayload: true },
    orderBy: { createdAt: "asc" },
  });
  const fence = candidates.find((candidate) => {
    if (candidate.status !== "PENDING") return true;
    const payload =
      candidate.requestPayload &&
      typeof candidate.requestPayload === "object" &&
      !Array.isArray(candidate.requestPayload)
        ? (candidate.requestPayload as Record<string, unknown>)
        : null;
    const hasDurableProviderEvidence = Boolean(
      payload?.ledgerSnapshot || payload?.checkpoint || payload?.history,
    );
    return !options?.allowUncheckpointedPending || hasDurableProviderEvidence;
  });
  return fence ? { id: fence.id, status: fence.status } : null;
}

export async function assertNoAppliedCreditDeallocationFence(
  paymentId: string,
  db: Prisma.TransactionClient,
  options?: {
    excludeOperationId?: string;
    allowUncheckpointedPending?: boolean;
  },
): Promise<void> {
  const fence = await findAppliedCreditDeallocationFence(paymentId, db, options);
  if (fence) {
    throw new XeroAppliedCreditOperationBusyError(
      `Applied-credit deallocation ${fence.id} is ${fence.status} for payment ${paymentId}; converge it before changing applied credit`,
    );
  }
}
