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
