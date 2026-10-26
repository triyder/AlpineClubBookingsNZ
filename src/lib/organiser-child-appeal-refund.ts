/**
 * #3956 (`INV-PAY-123`): the after-commit half of approving a refund appeal on
 * a booking the group organiser paid for by card - running the refund debt the
 * approval reserved, and telling the organiser. The approval itself (cap,
 * claim, reservation) lives in the route's `lock(1)` transaction and
 * `organiser-child-refund.ts`.
 */
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { sendGroupOrganiserJoinerRefundEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { runOrganiserChildRefundDebtNow } from "@/lib/organiser-child-refund-executor";
import { prisma } from "@/lib/prisma";

/**
 * Run the appeal's debt now, outside any transaction, and answer whether Stripe
 * has made the refund. Never throws: a failure leaves the debt owed for the
 * recovery runner, which retries it and alerts on exhaustion.
 */
export async function runOrganiserChildAppealRefundNow(
  debtId: string,
  refundRequestId: string,
  format: ClubFormat,
): Promise<boolean> {
  return runOrganiserChildRefundDebtNow(debtId, format).catch((err: unknown) => {
    logger.error(
      { err, refundRequestId, operationId: debtId },
      "Refund appeal's organiser-card refund did not run inline; the recovery runner owns it (#3956)",
    );
    return false;
  });
}

/**
 * Tell the group organiser that an approved appeal on a joiner's booking is
 * being refunded to their card. Skipped when the organiser has no address, or
 * it is the joiner's own (one person, already told). Never throws.
 */
export async function notifyOrganiserOfJoinerAppealRefund(input: {
  refundRequestId: string;
  organiserBookingId: string;
  joinerName: string;
  joinerEmail: string | null | undefined;
  amountCents: number;
  checkIn: Date;
  checkOut: Date;
  format: ClubFormat;
}): Promise<void> {
  try {
    const organiserBooking = await prisma.booking.findUnique({
      where: { id: input.organiserBookingId },
      select: {
        id: true,
        memberId: true,
        member: { select: { id: true, firstName: true, lastName: true, email: true } },
        organisation: { select: { name: true, email: true } },
      },
    });
    if (!organiserBooking) return;
    const organiser = bookingOwner(organiserBooking);
    const email = organiser.member.email;
    if (!email || email.toLowerCase() === input.joinerEmail?.toLowerCase()) return;
    await sendGroupOrganiserJoinerRefundEmail(
      {
        bookingContext: { bookingId: organiserBooking.id, recipientMemberId: organiser.memberId ?? null },
        email,
        firstName: organiser.member.firstName,
        joinerName: input.joinerName,
        amountCents: input.amountCents,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      },
      input.format,
    );
  } catch (err) {
    logger.error({ err, refundRequestId: input.refundRequestId }, "Failed to send the organiser's refund appeal email (#3956)");
  }
}
