/**
 * #4145 (`INV-PAY-134`): A CANCEL'S CARD REFUND CLOSED "PAID ANOTHER WAY" AFTER
 * PART OF IT WENT BACK TO THE CARD - a member cancel's, or a capacity race's.
 *
 * The cancel's REFUNDED event is written by the close that records the refund
 * made (`closeRefundRowRecordingEvent`). A row whose retries ran out after some
 * of its slices were made - inline, or by an earlier attempt - is closed by an
 * officer instead (`closeCardRefundPaidAnotherWay`), for what it still owes.
 * The part Stripe made did go back to the card, and nothing else records it for
 * the member: so that close records it here, in its own transaction, through
 * the same event writer (`recordRefundRowEvent`), marked as made before the
 * rest was paid another way - and the booking page says the parts apart. The
 * close's status-guarded claim makes it once per row. Nothing made, nothing
 * written: the whole refund was paid another way.
 */
import { BookingEventType, type Prisma } from "@prisma/client";

import { CAPACITY_RACE_REFUND_EVENT_REASON, recordCancelCardRefundEvent, recordRefundRowEvent } from "@/lib/booking-events";
import type { ClubFormat } from "@/lib/club-format";
import { isManualSettlementMarkerEvent } from "@/lib/manual-settlement-reversal-event";
import { cardRefundMadeForOperation, type CardRefundOwedPaymentRow } from "@/lib/open-card-refund-owed";
import {
  buildBookingCancellationRefundIdempotencyKey,
  buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking,
} from "@/lib/payment-recovery-keys";

/**
 * What the row's own slices took from the refunds recorded on its payment, read
 * under the close's lock (`cardRefundMadeForOperation`) - never the payment's
 * cap on what is still owed - dated by the latest of them as Stripe made it,
 * never before the cancel itself: Stripe dates a refund in whole seconds, so
 * one made in the cancel's own second can read as just before it, and the
 * history would then tell the refund before the cancel.
 */
export async function recordCardRefundMadeBeforePaidAnotherWay(
  tx: Prisma.TransactionClient,
  operation: { id: string; idempotencyKey: string; bookingId: string },
  { payment, format }: { payment: CardRefundOwedPaymentRow; format: ClubFormat },
): Promise<boolean> {
  const memberCancel = operation.idempotencyKey === buildBookingCancellationRefundIdempotencyKey(operation.bookingId);
  const capacityRace = operation.idempotencyKey.startsWith(buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(operation.bookingId));
  if (!memberCancel && !capacityRace) return false;
  const { madeCents, lastMadeAt } = cardRefundMadeForOperation(payment, operation.id);
  if (madeCents <= 0) return false;
  const made = {
    bookingId: operation.bookingId,
    amountCents: madeCents,
    actorMemberId: null,
    occurredAt: lastMadeAt ? await noEarlierThanTheCancel(tx, operation.bookingId, lastMadeAt) : undefined,
    madeBeforePaidAnotherWay: true,
  };
  if (memberCancel) return recordCancelCardRefundEvent(tx, { ...made, format });
  // A capacity race has a row per intent, each its own refund: no booking-wide once-check.
  await recordRefundRowEvent(tx, { ...made, reason: CAPACITY_RACE_REFUND_EVENT_REASON });
  return true;
}

/** `at`, or the booking's cancel if that came later (its settlement markers are not its cancel). */
async function noEarlierThanTheCancel(tx: Prisma.TransactionClient, bookingId: string, at: Date): Promise<Date> {
  const cancels = await tx.bookingEvent.findMany({
    where: { bookingId, type: BookingEventType.CANCELLED },
    orderBy: { occurredAt: "asc" },
    select: { type: true, occurredAt: true, snapshot: true },
  });
  const cancel = cancels.find((event) => !isManualSettlementMarkerEvent(event));
  return cancel && cancel.occurredAt.getTime() > at.getTime() ? cancel.occurredAt : at;
}
