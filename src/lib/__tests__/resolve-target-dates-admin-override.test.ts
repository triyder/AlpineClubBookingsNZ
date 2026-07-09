import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import {
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";

// resolveTargetDates is a pure function; only booking.status/checkIn/checkOut and
// the guest envelopes are read, so a minimal cast fixture is sufficient.
function makeBooking(
  status: string,
  checkIn: string,
  checkOut: string,
): LoadedBookingForModify {
  return {
    status,
    checkIn: new Date(`${checkIn}T00:00:00.000Z`),
    checkOut: new Date(`${checkOut}T00:00:00.000Z`),
    guests: [
      {
        id: "g1",
        stayStart: new Date(`${checkIn}T00:00:00.000Z`),
        stayEnd: new Date(`${checkOut}T00:00:00.000Z`),
      },
    ],
  } as unknown as LoadedBookingForModify;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveTargetDates admin override (issue #1668)", () => {
  it("lets an admin override move the check-in of an in-progress booking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = {
      checkIn: "2026-08-18",
      checkOut: "2026-08-22",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    const result = resolveTargetDates({ booking, role: "ADMIN", input });

    // admin-override mode is NOT in-progress, so the check-in lock is lifted.
    expect(result.isInProgressEdit).toBe(false);
    expect(result.checkInChanged).toBe(true);
    expect(result.newCheckIn.toISOString().slice(0, 10)).toBe("2026-08-18");
    expect(result.newCheckOut.toISOString().slice(0, 10)).toBe("2026-08-22");
  });

  it("lets an admin override move a fully-past booking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = {
      checkIn: "2026-08-10",
      checkOut: "2026-08-14",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    const result = resolveTargetDates({ booking, role: "ADMIN", input });
    expect(result.newCheckIn.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(result.newCheckOut.toISOString().slice(0, 10)).toBe("2026-08-14");
    expect(result.checkInChanged).toBe(true);
  });

  it("still locks the check-in for a member editing an in-progress booking (no flag)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = { checkIn: "2026-08-18", checkOut: "2026-08-24" };

    expect(() => resolveTargetDates({ booking, role: "USER", input })).toThrow(
      "Check-in cannot be changed for an in-progress booking",
    );
  });

  it("still refuses a member editing a fully-past booking (no flag)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = { checkIn: "2026-08-10", checkOut: "2026-08-14" };

    expect(() => resolveTargetDates({ booking, role: "USER", input })).toThrow(
      ApiError,
    );
  });

  it("ignores the override flag for a non-admin role (cannot self-drive an override)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = {
      checkIn: "2026-08-10",
      checkOut: "2026-08-14",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    // role USER carrying the flag falls through to the normal fully-past refusal.
    expect(() => resolveTargetDates({ booking, role: "USER", input })).toThrow(
      ApiError,
    );
  });
});
