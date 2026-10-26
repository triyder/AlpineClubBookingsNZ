/**
 * The officers' alert for a card payment the club could not move - the one
 * sender for a recovery that has run out of retries (`payment-recovery.ts`)
 * and, #4083 (`INV-PAY-128`), for a card refund Stripe refused
 * (`refused-card-refund-retry.ts`). Split out so the refusal's module can raise
 * it without importing the recovery runner.
 */
import type { ClubFormat } from "@/lib/club-format";
import { bookingOwner } from "@/lib/booking-owner";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** A send that reached nobody: what a once-only caller reads when the booking is gone. */
export const NOBODY_ALERTED: AdminAlertSendResult = {
  deliveryAllowed: true,
  recipients: 0,
  sent: 0,
  queuedForRetry: 0,
  notDelivered: 0,
};

/**
 * Returns the send's result, for a once-only caller (#4126), or null when the
 * booking no longer exists and nothing was sent.
 */
export async function alertPaymentRecoveryOfficers(
  alert: {
    bookingId: string;
    /** For the log only: a refusal the edit door meets has no row id in hand. */
    operationId?: string;
    amountCents: number;
    paymentIntentId: string;
    errorMessage: string;
  },
  format: ClubFormat,
): Promise<AdminAlertSendResult | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: alert.bookingId },
    // #3369: the owner may be an Organisation; bookingOwner() reads both.
    include: { member: true, organisation: { select: { name: true, email: true } } },
  });

  if (!booking) {
    logger.warn(
      { bookingId: alert.bookingId, operationId: alert.operationId },
      "Payment recovery failure alert skipped because booking no longer exists"
    );
    return null;
  }

  return sendAdminPaymentFailureAlert({
    memberName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents: alert.amountCents,
    errorMessage: alert.errorMessage,
    paymentIntentId: alert.paymentIntentId,
  }, format);
}
