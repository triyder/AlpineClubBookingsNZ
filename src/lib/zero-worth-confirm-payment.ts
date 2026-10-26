import { PaymentStatus, type Prisma } from "@prisma/client";

/**
 * #4399 (`INV-PAY-119`): the Payment row a pending-guest confirm writes for a
 * booking worth $0 - nothing charged, so $0 SUCCEEDED. The confirm-pending
 * cron and the officer's confirm-pending-guests route both call it on the
 * transaction client of the claim that moves the booking to PAID, after that
 * claim and under its lock(1): an edit recording a change fee takes lock(1)
 * too, so none can land between the PAID claim and this row. Before #4399 the
 * officer's route wrote it after its transaction committed.
 *
 * Only `amountCents` and `status` are written on an existing row; a recorded
 * change fee, the Stripe customer and any applied credit are left alone (the
 * callers have re-checked worth is $0 under the same locks).
 */
export async function writeZeroWorthConfirmPayment(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  await tx.payment.upsert({
    where: { bookingId },
    create: { bookingId, amountCents: 0, status: PaymentStatus.SUCCEEDED },
    update: { amountCents: 0, status: PaymentStatus.SUCCEEDED },
  });
}
