import { describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  computeRosterDayStatuses,
  type RosterStatusAssignment,
  type RosterStatusBooking,
  type RosterStatusGuest,
} from "@/lib/roster-status";

// roster-status imports prisma at module scope for getRosterMonthStatus; the
// pure computeRosterDayStatuses under test never touches it. Mock it so no real
// client is constructed.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
  },
}));

function guest(
  stayStart: string,
  stayEnd: string,
  ageTier?: string,
): RosterStatusGuest {
  return {
    stayStart: parseDateOnly(stayStart),
    stayEnd: parseDateOnly(stayEnd),
    ...(ageTier ? { ageTier } : {}),
  };
}

function booking(
  id: string,
  checkIn: string,
  checkOut: string,
  guests: RosterStatusGuest[],
): RosterStatusBooking {
  return {
    id,
    checkIn: parseDateOnly(checkIn),
    checkOut: parseDateOnly(checkOut),
    guests,
  };
}

function assignment(
  date: string,
  status: RosterStatusAssignment["status"],
  bookingId: string,
): RosterStatusAssignment {
  return { date: parseDateOnly(date), status, bookingId };
}

// A single booking staying nights 07-10 and 07-11 (checkout 07-12, half-open).
const B1 = booking("b1", "2099-07-10", "2099-07-12", [guest("2099-07-10", "2099-07-12", "ADULT")]);

describe("computeRosterDayStatuses", () => {
  it("marks a date with no staying booking as no-guests", () => {
    const [result] = computeRosterDayStatuses(["2099-07-20"], [B1], []);
    expect(result).toEqual({
      date: "2099-07-20",
      status: "no-guests",
      stayingBookingCount: 0,
      uncoveredBookingCount: 0,
    });
  });

  it("treats the checkout day (half-open stay) as no-guests", () => {
    const [result] = computeRosterDayStatuses(["2099-07-12"], [B1], []);
    expect(result.status).toBe("no-guests");
  });

  it("marks a staying date with zero assignments as needs-roster", () => {
    const [result] = computeRosterDayStatuses(["2099-07-10"], [B1], []);
    expect(result).toEqual({
      date: "2099-07-10",
      status: "needs-roster",
      stayingBookingCount: 1,
      uncoveredBookingCount: 0,
    });
  });

  it("marks a date with any SUGGESTED assignment as suggested", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "SUGGESTED", "b1")],
    );
    expect(result.status).toBe("suggested");
  });

  it("precedence: mixed SUGGESTED + CONFIRMED resolves to suggested", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [
        assignment("2099-07-10", "CONFIRMED", "b1"),
        assignment("2099-07-10", "SUGGESTED", "b1"),
      ],
    );
    expect(result.status).toBe("suggested");
  });

  it("marks a fully-covered confirmed date as confirmed", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result).toEqual({
      date: "2099-07-10",
      status: "confirmed",
      stayingBookingCount: 1,
      uncoveredBookingCount: 0,
    });
  });

  it("COMPLETED assignments also count as covering (confirmed)", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "COMPLETED", "b1")],
    );
    expect(result.status).toBe("confirmed");
  });

  it("case (a): coverage is by bookingId, so a null-guest assignment row still covers its booking", () => {
    // In production a null-bookingGuestId row still carries a non-null bookingId.
    // roster-status only tracks bookingId, so such a row covers the booking and
    // the date does NOT trip needs-attention.
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result.status).toBe("confirmed");
    expect(result.uncoveredBookingCount).toBe(0);
  });

  it("case (b): a booking added after confirmation with no rows trips needs-attention", () => {
    const late = booking("b2", "2099-07-10", "2099-07-11", [guest("2099-07-10", "2099-07-11", "ADULT")]);
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1, late],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result).toEqual({
      date: "2099-07-10",
      status: "needs-attention",
      stayingBookingCount: 2,
      uncoveredBookingCount: 1,
    });
  });

  it("case (c): a busy night where every staying booking has >=1 row does not trip needs-attention", () => {
    // One booking, three guests, but only a single assignment row for the
    // booking. Coverage is per-booking, so this stays confirmed even though two
    // individual guests have no chore.
    const busy = booking("busy", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "ADULT"),
      guest("2099-07-10", "2099-07-11", "ADULT"),
      guest("2099-07-10", "2099-07-11", "YOUTH"),
    ]);
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [busy],
      [assignment("2099-07-10", "CONFIRMED", "busy")],
    );
    expect(result.status).toBe("confirmed");
  });

  it("only counts assignments matching the date (ignores other days' rows)", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-11", "CONFIRMED", "b1")],
    );
    // No row for 07-10 → needs-roster, even though 07-11 has one.
    expect(result.status).toBe("needs-roster");
  });

  it("computes each date independently across a range", () => {
    const results = computeRosterDayStatuses(
      ["2099-07-10", "2099-07-11", "2099-07-12"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(results.map((r) => r.status)).toEqual([
      "confirmed", // covered
      "needs-roster", // staying, no rows
      "no-guests", // checkout day
    ]);
  });

  describe("requireAdultOrYouthForAttention", () => {
    const adultCovered = booking("adult", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "ADULT"),
    ]);
    const childOnly = booking("child", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "CHILD"),
    ]);
    const confirmChild = [assignment("2099-07-10", "CONFIRMED", "adult")];

    it("default (false): a child-only uncovered booking trips needs-attention", () => {
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, childOnly],
        confirmChild,
      );
      expect(result.status).toBe("needs-attention");
      expect(result.uncoveredBookingCount).toBe(1);
    });

    it("knob on: a child-only uncovered booking is excluded → confirmed", () => {
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, childOnly],
        confirmChild,
        { requireAdultOrYouthForAttention: true },
      );
      expect(result.status).toBe("confirmed");
      // stayingBookingCount still counts every staying booking.
      expect(result.stayingBookingCount).toBe(2);
    });

    it("knob on: an uncovered ADULT booking still trips needs-attention", () => {
      const adultUncovered = booking("adult2", "2099-07-10", "2099-07-11", [
        guest("2099-07-10", "2099-07-11", "ADULT"),
      ]);
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, adultUncovered],
        confirmChild,
        { requireAdultOrYouthForAttention: true },
      );
      expect(result.status).toBe("needs-attention");
      expect(result.uncoveredBookingCount).toBe(1);
    });
  });
});
