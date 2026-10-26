import type { Prisma } from "@prisma/client";
import { COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE, refundRequestIdOfHandBack } from "@/lib/manual-refund-task-settlement-rules";
import { prisma } from "@/lib/prisma";

type TaskReader = Pick<Prisma.TransactionClient, "manualRefundTask">;

/** One refund request paid back on a payment: its id, and the cash its completion recorded. */
export type PaidBackRefundRequest = { paymentId: string; refundRequestId: string; amountCents: number };

/**
 * #4215 (`INV-PAY-118`, `INV-ADDPAY-021`): every refund request paid back on
 * these payments, as their completions recorded it
 * (`COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE`). THE one read of it: the
 * inbound repair that rebuilds a refunded total from the payment's Xero notes
 * adds the cash, and the booking repair tool takes it out of the cash a
 * cancellation's note answers and (#4231) queues a request's own note the
 * completion could not, so they give one answer.
 *
 * Never read from a request's own note (`REFUND_REQUEST_CREDIT_NOTE`): it may
 * still be queued or voided (#4195) while the cash stays paid back, and a
 * request completed before the booking had an invoice queued none. Never
 * attributed to the canonical note.
 */
export async function readPaidBackRefundRequests(
  paymentIds: readonly string[],
  db: TaskReader = prisma,
): Promise<PaidBackRefundRequest[]> {
  if (paymentIds.length === 0) return [];
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId: { in: [...paymentIds] }, ...COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE },
    select: { paymentId: true, amountCents: true, kind: true, occurrenceKey: true },
  });
  return tasks.flatMap((task) => {
    const refundRequestId = refundRequestIdOfHandBack(task);
    return task.paymentId === null || refundRequestId === null
      ? []
      : [{ paymentId: task.paymentId, refundRequestId, amountCents: Math.max(task.amountCents ?? 0, 0) }];
  });
}

/** The same requests' cash, summed per payment. */
export async function readRefundRequestPaidBackCentsByPaymentId(
  paymentIds: readonly string[],
  db: TaskReader = prisma,
): Promise<Map<string, number>> {
  return sumPaidBackByPaymentId(await readPaidBackRefundRequests(paymentIds, db));
}

function sumPaidBackByPaymentId(requests: readonly PaidBackRefundRequest[]): Map<string, number> {
  const centsByPaymentId = new Map<string, number>();
  for (const request of requests) {
    centsByPaymentId.set(request.paymentId, (centsByPaymentId.get(request.paymentId) ?? 0) + request.amountCents);
  }
  return centsByPaymentId;
}
