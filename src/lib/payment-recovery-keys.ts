// Pure idempotency-key builders for payment recovery operations, split from
// payment-recovery.ts so dependency-injected consumers (the booking-vs-Xero
// repair loader, #1491) can build keys without importing the Prisma client
// that module initializes at load time.

export function buildBookingCancellationRefundIdempotencyKey(bookingId: string) {
  return `booking_cancel_refund_recovery_${bookingId}`;
}

// #1494: the Stripe refund `metadata` for a booking-cancellation card refund.
// The inline cancel path (which creates the Stripe refund) and the recovery
// cron (which replays it under the shared `booking_cancel_refund_<bookingId>`
// idempotency key) both build the body from THIS one function, so the two send
// a byte-identical request body. Stripe rejects a reused idempotency key whose
// parameters differ (`idempotency_error`) instead of replaying, so the exact
// crash scenario the frozen plan exists for — inline Stripe refund succeeded
// but the local recording was lost — only converges if the replay's metadata
// matches the original's byte for byte. The shape is a pure function of
// `bookingId` plus constants: it deliberately carries NO per-cancellation value
// (the refund percentage used to ride here) because the cron cannot reconstruct
// such a value from the persisted operation, and recomputing it at replay time
// would drift (days-until-check-in and the policy can both change). Nothing
// downstream reads this metadata off the Stripe refund — it is dashboard-only.
export function buildBookingCancellationRefundMetadata(
  bookingId: string,
): Record<string, string> {
  return { bookingId, reason: "cancellation" };
}

// #1507: the Stripe refund `metadata` for an approved refund-request (appeal)
// card refund. The admin approve route creates the Stripe refund under the
// `refund_request_<id>` idempotency-key prefix; if that inline refund fails the
// recovery cron replays it under the SAME prefix (#1039). Both build the body
// from THIS one function, so the two send a byte-identical request body. As with
// the booking-cancellation convergence (#1494), Stripe rejects a reused
// idempotency key whose parameters differ (`idempotency_error`) instead of
// replaying, so the crash the durable recovery exists for — inline Stripe refund
// succeeded but the local recording was lost — only converges if the replay's
// metadata matches the original's byte for byte. Before #1507 the cron sent
// `reason: "refund_request_refund_recovery"` while the route sent
// `reason: "refund_appeal_approved"`. The inline shape is UNCHANGED by this
// convergence (only the recovery branch now matches), so every Stripe refund the
// route has ever created already carries this exact body — there is no
// pre-deploy sliver. Nothing downstream reads this off the Stripe refund; it is
// dashboard-only.
export function buildRefundRequestRefundMetadata(
  bookingId: string,
  refundRequestId: string,
): Record<string, string> {
  return { bookingId, reason: "refund_appeal_approved", refundRequestId };
}

// #1507: the Stripe refund `metadata` for a booking-modification card refund
// (date change / batch edit / guest removal). The inline settlement helper
// (executeBookingModificationRefund) stamps a per-path `reason`; the recovery
// cron replays under the modification's stored Stripe key prefix (#1152) and
// must send the SAME body so Stripe replays the original refund instead of
// rejecting the reused key with `idempotency_error` (the #1494 failure mode).
// The shape is shared through this builder; the recovery reconstructs the
// per-path `reason` from the persisted key prefix via
// bookingModificationRefundReasonForKeyPrefix, so the inline shape is UNCHANGED
// for stored-prefix rows (no pre-deploy sliver). Nothing downstream reads this
// off the Stripe refund; it is dashboard-only.
export function buildBookingModificationRefundMetadata(
  bookingId: string,
  reason: string,
): Record<string, string> {
  return { bookingId, reason };
}

// #1507: map a modification refund's persisted Stripe idempotency-key prefix
// (`stripeKeyPrefix`, #1152) back to the `reason` the inline settlement helper
// stamped, so a recovery replay reconstructs the inline Stripe body
// byte-for-byte. The three prefixes mirror the `idempotencyKeyPrefix` each
// modification caller passes to executeBookingModificationRefund
// (booking-date/-batch modification services and the guest-removal route). A NEW
// modification refund path MUST add its prefix here, or its recovery replay
// diverges (safe-fails to idempotency_error, never double-refunds). Legacy rows
// enqueued before #1152 carry no stored prefix; they keep the historical
// recovery reason and their operation-scoped key (they were never shared-key
// with the inline refund, so convergence does not apply to them).
export function bookingModificationRefundReasonForKeyPrefix(
  keyPrefix: string | null | undefined,
): string {
  if (keyPrefix?.startsWith("mod_dates_refund_")) {
    return "date_change_price_decrease";
  }
  if (keyPrefix?.startsWith("mod_batch_refund_")) {
    return "batch_modification";
  }
  if (keyPrefix?.startsWith("guest_remove_refund_")) {
    return "guest_removed_price_decrease";
  }
  return "booking_modification_refund_recovery";
}
