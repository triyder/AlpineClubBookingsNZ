import type { PaymentRecoveryOperation } from "@prisma/client";

import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import logger from "@/lib/logger";
import { cardRefundOperationUnmadeCents, isOwedCardRefundOperation, openCardRefundOwedByOperation } from "@/lib/open-card-refund-owed";
import { prisma } from "@/lib/prisma";

/**
 * #4117: what a dead card refund still owes, read AFTER it was marked failed -
 * the claim-time copy predates its final attempt, which may have made slices -
 * as "Refunds owed" reads it, netting the refunds recorded since
 * (`openCardRefundOwedByOperation`). Any other operation, or a read that fails,
 * falls back to its own record (`cardRefundOperationUnmadeCents`).
 */
export async function cardRefundStillOwedCents(operation: PaymentRecoveryOperation): Promise<number> {
  if (!isOwedCardRefundOperation(operation)) return cardRefundOperationUnmadeCents(operation);
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: operation.paymentId },
      select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
    });
    const owed = payment ? openCardRefundOwedByOperation(payment).get(operation.id) : undefined;
    if (typeof owed === "number") return owed;
  } catch (err) {
    logger.error({ err, operationId: operation.id }, "Could not read what a dead card refund still owes; alerting with its own record (#4117)");
  }
  return cardRefundOperationUnmadeCents(operation);
}
