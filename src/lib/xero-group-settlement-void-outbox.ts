import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import { XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * Persist the compensating VOID debt for a cancelled combined group invoice.
 *
 * This is deliberately independent of the original CREATE operation: that row
 * may already be SUCCEEDED when the organiser later cancels.  The active
 * correlation-key partial index and the pre-check below make concurrent
 * cancellation/worker observations converge on one replayable UPDATE row.
 */
export async function enqueueXeroGroupSettlementInvoiceVoidOperation(
  settlementId: string,
  options?: {
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
  }
) {
  const db = options?.store ?? prisma;
  const settlement = await db.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
      groupBooking: { select: { status: true } },
    },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  if (settlement.groupBooking.status !== "CANCELLED") {
    return { queueOperationId: null, message: "Group is not cancelled." };
  }
  if (!settlement.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Cancelled group has no persisted Xero invoice to void.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlement.id,
    "invoice-void-after-cancel",
    settlement.xeroInvoiceId,
    "v1"
  );
  const existing = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return {
      queueOperationId: existing.id,
      message: "Xero group invoice VOID is already queued.",
    };
  }

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "GroupBookingSettlement",
    localId: settlement.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
      settlementId: settlement.id,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: options?.store,
  });
  return {
    queueOperationId: operation.id,
    message: "Xero group invoice VOID queued for background processing.",
  };
}
