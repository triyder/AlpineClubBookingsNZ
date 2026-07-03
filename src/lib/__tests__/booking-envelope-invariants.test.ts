import { describe, expect, it, vi } from "vitest";

import {
  assertBookingEnvelopeInvariants,
  BOOKING_ENVELOPE_CONSTRAINTS,
  FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL,
  isBookingEnvelopeInvariantViolation,
} from "@/lib/booking-envelope-invariants";
import type { Prisma } from "@prisma/client";

describe("assertBookingEnvelopeInvariants", () => {
  it("flushes both envelope constraint triggers by name", async () => {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
    await assertBookingEnvelopeInvariants(
      tx as unknown as Prisma.TransactionClient,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL,
    );
    for (const name of BOOKING_ENVELOPE_CONSTRAINTS) {
      expect(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL).toContain(`"${name}"`);
    }
    expect(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL).toMatch(/^SET CONSTRAINTS /);
    expect(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL).toMatch(/ IMMEDIATE$/);
  });
});

describe("isBookingEnvelopeInvariantViolation", () => {
  it("recognizes the constraint name in an error message", () => {
    const error = new Error(
      'BookingGuest stay range must be within parent Booking date range (constraint "BookingGuest_stay_range_within_booking")',
    );
    expect(isBookingEnvelopeInvariantViolation(error)).toBe(true);
  });

  it("recognizes the Prisma v7 pg-adapter P2010 shape (constraint name absent)", () => {
    // Exact shape observed from prisma.$executeRawUnsafe(SET CONSTRAINTS …)
    // via @prisma/adapter-pg 7.x: the constraint field is dropped and only
    // the trigger message text survives.
    const driverAdapterError = Object.assign(
      new Error("BookingGuest stay range must be within parent Booking date range"),
      {
        cause: {
          kind: "postgres",
          code: "23514",
          message:
            "BookingGuest stay range must be within parent Booking date range",
          detail:
            "bookingId=b1 stayStart=2026-09-10 stayEnd=2026-09-25 checkIn=2026-09-10 checkOut=2026-09-14",
        },
      },
    );
    const error = Object.assign(
      new Error(
        "Invalid `prisma.$executeRawUnsafe()` invocation:\n\nRaw query failed. Code: `23514`. Message: `BookingGuest stay range must be within parent Booking date range`",
      ),
      { code: "P2010", meta: { driverAdapterError } },
    );
    expect(isBookingEnvelopeInvariantViolation(error)).toBe(true);
    // The nested driver error alone (e.g. surfaced from a COMMIT) matches too.
    expect(isBookingEnvelopeInvariantViolation(driverAdapterError)).toBe(true);
  });

  it("recognizes the booking-side trigger message", () => {
    const error = new Error(
      "Raw query failed. Code: `23514`. Message: `Booking date range must contain all BookingGuest stay ranges`",
    );
    expect(isBookingEnvelopeInvariantViolation(error)).toBe(true);
  });

  it("recognizes a plain node-postgres error via its constraint field", () => {
    const error = Object.assign(new Error("value violates constraint"), {
      code: "23514",
      constraint: "BookingGuest_stay_range_within_booking",
    });
    expect(isBookingEnvelopeInvariantViolation(error)).toBe(true);
  });

  it("recognizes a violation nested under error.cause", () => {
    const error = new Error("Transaction failed", {
      cause: Object.assign(new Error("db error"), {
        message:
          'trigger raised: constraint "Booking_dates_consistent_with_guests"',
      }),
    });
    expect(isBookingEnvelopeInvariantViolation(error)).toBe(true);
  });

  it("rejects unrelated errors and non-error values", () => {
    expect(isBookingEnvelopeInvariantViolation(new Error("boom"))).toBe(false);
    expect(
      isBookingEnvelopeInvariantViolation(
        Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["email"] } }),
      ),
    ).toBe(false);
    expect(isBookingEnvelopeInvariantViolation(null)).toBe(false);
    expect(isBookingEnvelopeInvariantViolation(undefined)).toBe(false);
    expect(isBookingEnvelopeInvariantViolation("plain string")).toBe(false);
  });
});
