/**
 * Group bookings — organiser-cancel cleanup.
 *
 * When the organiser cancels their host booking, the existing cancel path
 * (booking-cancel.ts) cancels and refunds the organiser's *own* booking and any
 * linked provisional (PENDING) non-member child. That leaves a gap for groups:
 *
 *   - EACH_PAYS_OWN joiners own and pay their own independent child bookings, so
 *     they are intentionally left intact; we only close the group to new joins.
 *
 *   - ORGANISER_PAYS joiners rely entirely on the organiser to settle. Their
 *     child bookings are never PENDING (they are PAYMENT_PENDING, then CONFIRMED
 *     once the organiser commits to settle, then PAID), so the PENDING-only
 *     cleanup never touches them. Cancelling the organiser would otherwise strand
 *     them: CONFIRMED beds keep holding lodge capacity with the payer gone, and
 *     nothing can ever be settled. This module cancels those children, releases
 *     their beds, and — for a group that was already settled — refunds the
 *     organiser.
 *
 * The settlement is a single Stripe PaymentIntent for the combined total, so the
 * refund is one Stripe refund. The refund amount follows the *same* date-based
 * cancellation policy as the organiser's own booking and every normal booking
 * (calculateRefundAmount), applied per paid child so each child's Xero refund
 * credit note (allocated against that child's own settlement invoice) sums
 * exactly to the single Stripe refund.
 *
 * Conventions match group-booking.ts: integer cents, NZ date-only booking dates,
 * Stripe/Xero calls run outside the database transaction. Everything here is
 * best-effort and idempotent: the Stripe refund carries an idempotency key, the
 * settlement guards on its own status, and already-CANCELLED children are skipped
 * by the status filter, so a re-run never double-refunds or double-cancels.
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "./prisma";
import { processRefund, cancelPaymentIntentIfCancellable } from "./stripe";
import {
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { reconcileBedAllocationsForBooking } from "./bed-allocation-lifecycle";
import { revokePaymentLinksForBooking } from "./payment-link";
import { recordBookingEvent } from "./booking-events";
import { logAudit } from "./audit";
import { sendBookingCancelledEmail } from "./email";
import { processWaitlistForDates } from "./waitlist";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import { isXeroConnected } from "./xero";
import logger from "@/lib/logger";

/** Child booking statuses that an organiser cancel must clean up. */
const ACTIVE_CHILD_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

async function markGroupCancelled(groupBookingId: string): Promise<void> {
  await prisma.groupBooking.update({
    where: { id: groupBookingId },
    data: { status: GroupBookingStatus.CANCELLED },
  });
}

/**
 * Clean up a group when its organiser cancels the host booking. A no-op when the
 * cancelled booking does not host a group. Never throws: the organiser's own
 * cancellation has already committed, so failures here are logged loudly rather
 * than surfaced (the refund is idempotent and the work is safe to re-run).
 */
export async function settleGroupBookingOnOrganiserCancel(
  organiserBookingId: string,
  sessionUserId: string,
  ipAddress: string
): Promise<void> {
  const group = await prisma.groupBooking.findUnique({
    where: { organiserBookingId },
    include: { settlement: true },
  });
  if (!group) {
    return; // The cancelled booking does not host a group.
  }

  // EACH_PAYS_OWN: joiners own and pay their own bookings; leave them untouched.
  // Just close the group so it accepts no further joins.
  if (group.paymentMode !== GroupBookingPaymentMode.ORGANISER_PAYS) {
    await markGroupCancelled(group.id);
    return;
  }

  const children = await prisma.booking.findMany({
    where: {
      parentBookingId: organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [...ACTIVE_CHILD_STATUSES] },
    },
    include: { member: true, payment: true },
  });

  const settlement = group.settlement;

  // Mid-settlement: an open (PENDING) intent with children committed to CONFIRMED
  // but not yet captured. Void the intent and fail the settlement BEFORE
  // cancelling the children, so the success webhook — which only settles CONFIRMED
  // children — cannot charge the organiser for beds we are about to release.
  if (
    settlement &&
    settlement.status === PaymentStatus.PENDING &&
    settlement.stripePaymentIntentId
  ) {
    try {
      await cancelPaymentIntentIfCancellable(settlement.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to void open group settlement intent on organiser cancel"
      );
    }
    await prisma.groupBookingSettlement.update({
      where: { id: settlement.id },
      data: { status: PaymentStatus.FAILED },
    });
  }

  // Refund the organiser when the group was already settled. Only genuinely PAID
  // children were charged (a member could have joined after settlement and still
  // be unpaid), so the policy refund is computed per paid child and summed.
  const settled = settlement?.status === PaymentStatus.SUCCEEDED;
  const refundByChildId = new Map<string, number>();
  let totalRefundCents = 0;

  if (settled && children.length > 0) {
    const checkIn = children[0].checkIn;
    const days = daysUntilDate(checkIn);
    const policy = await loadCancellationPolicy(checkIn);
    for (const child of children) {
      const isPaid =
        child.status === BookingStatus.PAID &&
        child.payment?.status === PaymentStatus.SUCCEEDED;
      if (!isPaid) {
        continue;
      }
      const { refundAmountCents } = calculateRefundAmount(
        child.finalPriceCents,
        days,
        policy,
        "card"
      );
      if (refundAmountCents > 0) {
        refundByChildId.set(child.id, refundAmountCents);
        totalRefundCents += refundAmountCents;
      }
    }

    if (
      totalRefundCents > 0 &&
      settlement?.stripePaymentIntentId &&
      settlement.status === PaymentStatus.SUCCEEDED
    ) {
      try {
        await processRefund({
          paymentIntentId: settlement.stripePaymentIntentId,
          amountCents: totalRefundCents,
          metadata: {
            groupBookingId: group.id,
            reason: "organiser_cancellation",
          },
          idempotencyKey: `group_cancel_refund_${group.id}_${totalRefundCents}`,
        });
        await prisma.groupBookingSettlement.update({
          where: { id: settlement.id },
          data: {
            status:
              totalRefundCents >= settlement.amountCents
                ? PaymentStatus.REFUNDED
                : PaymentStatus.PARTIALLY_REFUNDED,
          },
        });
      } catch (err) {
        // Leave the settlement SUCCEEDED for an operator to reconcile; still
        // release the beds below so capacity is not held by the orphaned group.
        logger.error(
          { err, groupBookingId: group.id, totalRefundCents },
          "Failed to refund group settlement on organiser cancel"
        );
        refundByChildId.clear();
        totalRefundCents = 0;
      }
    }
  }

  for (const child of children) {
    const refundForChild = refundByChildId.get(child.id) ?? 0;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: child.id },
          data: { status: BookingStatus.CANCELLED },
        });
        await reconcileBedAllocationsForBooking({
          bookingId: child.id,
          db: tx,
          previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
        });
        await revokePaymentLinksForBooking(child.id, tx);
        if (refundForChild > 0 && child.payment) {
          const nextRefunded = Math.min(
            child.payment.amountCents,
            child.payment.refundedAmountCents + refundForChild
          );
          await tx.payment.update({
            where: { id: child.payment.id },
            data: {
              refundedAmountCents: nextRefunded,
              status:
                nextRefunded >= child.payment.amountCents
                  ? PaymentStatus.REFUNDED
                  : PaymentStatus.PARTIALLY_REFUNDED,
            },
          });
        }
      });
    } catch (err) {
      logger.error(
        { err, bookingId: child.id, groupBookingId: group.id },
        "Failed to cancel group joiner booking on organiser cancel"
      );
      continue;
    }

    // Xero refund credit note per paid child, allocated against that child's own
    // settlement invoice so the books balance per joiner.
    if (refundForChild > 0 && child.payment) {
      try {
        const queued = await enqueueXeroRefundCreditNoteOperation(
          child.payment.id,
          refundForChild,
          { createdByMemberId: sessionUserId }
        );
        if (queued.queueOperationId && (await isXeroConnected())) {
          void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch(
            (xeroErr) =>
              logger.error(
                { err: xeroErr, bookingId: child.id },
                "Failed to kick Xero refund credit note worker after organiser cancel"
              )
          );
        }
      } catch (xeroErr) {
        logger.error(
          { err: xeroErr, bookingId: child.id, groupBookingId: group.id },
          "Failed to queue Xero refund credit note for cancelled group joiner"
        );
      }
    }

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: child.id,
      subjectMemberId: child.memberId,
      entityType: "Booking",
      entityId: child.id,
      category: "booking",
      severity: "critical",
      outcome: "success",
      summary: "Group joiner booking cancelled with organiser cancel",
      details:
        refundForChild > 0
          ? `Group organiser cancelled; refunded ${refundForChild} cents of the settled beds to the organiser`
          : "Group organiser cancelled; released the held spot (no payment taken)",
      metadata: {
        groupBookingId: group.id,
        organiserBookingId,
        statusBefore: child.status,
        refundForChild,
        paymentId: child.payment?.id ?? null,
      },
      ipAddress,
    });

    await recordBookingEvent({
      bookingId: child.id,
      type: refundForChild > 0 ? BookingEventType.REFUNDED : BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      amountCents: refundForChild > 0 ? refundForChild : undefined,
      reason:
        refundForChild > 0
          ? "Group organiser cancelled the booking; the settled beds were refunded to the organiser."
          : "Group organiser cancelled the booking, releasing this held spot.",
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to record booking event for cancelled group joiner"
      )
    );

    sendBookingCancelledEmail(
      child.member.email,
      child.member.firstName,
      child.checkIn,
      child.checkOut,
      refundForChild,
      "card"
    ).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to send cancellation email to group joiner"
      )
    );

    processWaitlistForDates({
      checkIn: child.checkIn,
      checkOut: child.checkOut,
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to process waitlist after group joiner cancellation"
      )
    );
  }

  await markGroupCancelled(group.id);

  logger.info(
    {
      groupBookingId: group.id,
      organiserBookingId,
      cancelledChildren: children.length,
      totalRefundCents,
    },
    "Cleaned up group booking on organiser cancel"
  );
}
