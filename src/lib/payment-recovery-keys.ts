// Pure idempotency-key builders for payment recovery operations, split from
// payment-recovery.ts so dependency-injected consumers (the booking-vs-Xero
// repair loader, #1491) can build keys without importing the Prisma client
// that module initializes at load time.

export function buildBookingCancellationRefundIdempotencyKey(bookingId: string) {
  return `booking_cancel_refund_recovery_${bookingId}`;
}
