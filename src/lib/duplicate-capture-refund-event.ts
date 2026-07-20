/**
 * Shared, PURE contract for the #1992 duplicate-capture auto-refund
 * BookingEvent (#2008).
 *
 * When a SECOND, distinct Stripe capture lands on an already-PAID booking (the
 * residual #1967 split-child window) it is auto-refunded. #1992 deliberately
 * recorded NO BookingEvent for that refund because the shared member/admin
 * narrative (`buildCancelledPostPaymentNarrative`) pattern-matches the first
 * REFUNDED event as a LATER cancellation's settlement clause and would misstate
 * the story. #2008 adds a durable, ADMIN-ONLY history entry without reopening
 * that hazard: the refund is recorded as a REFUNDED BookingEvent carrying this
 * discriminator in its `snapshot`, and every consumer that pattern-matches
 * REFUNDED events (the narrative) MUST exclude it via `isDuplicateCaptureRefundEvent`.
 *
 * This module is intentionally free of the database client and logger so the
 * "pure" narrative resolver (`src/lib/booking-narrative.ts`) can import the
 * predicate without pulling `@/lib/prisma` into its bundle. It depends only on
 * the `@prisma/client` enum, which the narrative already imports.
 */
import { BookingEventType } from "@prisma/client";

/** Snapshot discriminator marking a REFUNDED event as a #1992 duplicate-capture refund. */
export const DUPLICATE_CAPTURE_REFUND_EVENT_KIND = "duplicate_capture_refund" as const;

/**
 * Honest, member-neutral copy stored on the event's `reason`. Rendered on the
 * admin booking-history timeline; never enters the member/guest narrative.
 */
export const DUPLICATE_CAPTURE_REFUND_EVENT_REASON =
  "Duplicate card capture auto-refunded — the booking's settlement is unaffected.";

/** Frozen facts stored on the duplicate-capture auto-refund BookingEvent snapshot. */
export interface DuplicateCaptureRefundEventSnapshot {
  kind: typeof DUPLICATE_CAPTURE_REFUND_EVENT_KIND;
  /** The arriving duplicate capture's PaymentIntent id that was refunded. */
  duplicatePaymentIntentId: string;
  /** The intent that actually settled the booking (unaffected), when known. */
  settledPaymentIntentId: string | null;
  /** Amount auto-refunded, integer cents (mirrors the event's amountCents). */
  refundedAmountCents: number;
}

/**
 * Narrow an arbitrary event snapshot to a duplicate-capture refund snapshot,
 * or null when it is not one.
 */
export function asDuplicateCaptureRefundSnapshot(
  value: unknown
): DuplicateCaptureRefundEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === DUPLICATE_CAPTURE_REFUND_EVENT_KIND
  ) {
    return value as DuplicateCaptureRefundEventSnapshot;
  }
  return null;
}

/**
 * True when a durable event is the #1992 duplicate-capture auto-refund: a
 * REFUNDED event carrying the discriminator snapshot. The booking narrative
 * excludes these so the auto-refund is never misread as a cancellation's
 * settlement.
 */
export function isDuplicateCaptureRefundEvent(event: {
  type: BookingEventType;
  snapshot: unknown;
}): boolean {
  return (
    event.type === BookingEventType.REFUNDED &&
    asDuplicateCaptureRefundSnapshot(event.snapshot) !== null
  );
}
