import type { Prisma } from "@prisma/client";

/**
 * The deferred constraint triggers that enforce the stay-range envelope at
 * the database layer (see migrations
 * 20260525030000_enforce_booking_guest_stay_range_envelope and
 * 20260704100000_defer_booking_guest_stay_range_triggers).
 */
export const BOOKING_ENVELOPE_CONSTRAINTS = [
  "BookingGuest_stay_range_within_booking",
  "Booking_dates_consistent_with_guests",
] as const;

export const FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL = `SET CONSTRAINTS ${BOOKING_ENVELOPE_CONSTRAINTS.map(
  (name) => `"${name}"`,
).join(", ")} IMMEDIATE`;

/**
 * Run the deferred envelope constraint triggers now instead of at COMMIT.
 *
 * The triggers are DEFERRABLE INITIALLY DEFERRED so modification flows may
 * write guest rows and the parent Booking row in any order. The cost is that
 * a genuine violation (a write-path bug) would otherwise surface as an
 * anonymous commit failure from prisma.$transaction. Calling this as the
 * last statement of a transaction that writes BookingGuest stay ranges or
 * Booking checkIn/checkOut fires the queued checks at an attributable point:
 * the error carries the calling service's stack trace and is caught by the
 * route like any other in-transaction failure. Legitimate edits pass exactly
 * as they would at commit — by this point the envelope is final.
 */
export async function assertBookingEnvelopeInvariants(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRawUnsafe(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL);
}

/**
 * The RAISE EXCEPTION texts from the trigger functions. The pg driver
 * adapter drops the Postgres `constraint` field when wrapping the error, so
 * these messages (which appear verbatim in every wrapper layer) are the
 * reliable signal alongside the constraint names.
 */
export const BOOKING_ENVELOPE_TRIGGER_MESSAGES = [
  "BookingGuest stay range must be within parent Booking date range",
  "Booking date range must contain all BookingGuest stay ranges",
] as const;

function collectErrorText(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "detail", "constraint"]) {
    if (typeof record[key] === "string") parts.push(record[key] as string);
  }
  for (const key of ["meta", "driverAdapterError", "cause"]) {
    if (record[key]) parts.push(collectErrorText(record[key], depth + 1));
  }
  return parts.join("\n");
}

/**
 * True when an error originated from one of the envelope constraint
 * triggers, wherever it surfaced: a Prisma raw-query P2010 whose message
 * embeds the trigger text, the driver-adapter error nested under
 * meta.driverAdapterError/cause, or a plain node-postgres error carrying the
 * constraint name. Routes use this to log the violation with full detail and
 * return a clean 500 instead of leaking the raw trigger message to the
 * client.
 */
export function isBookingEnvelopeInvariantViolation(error: unknown): boolean {
  const text = collectErrorText(error);
  return (
    BOOKING_ENVELOPE_CONSTRAINTS.some((name) => text.includes(name)) ||
    BOOKING_ENVELOPE_TRIGGER_MESSAGES.some((message) => text.includes(message))
  );
}
