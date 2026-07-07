import { describe, expect, it, vi } from "vitest";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function buildDb(options: {
  hutLeaderLookaheadDays?: number;
  bookings?: Array<{
    checkIn: Date;
    checkOut: Date;
    guests?: Array<{ stayStart?: Date | null; stayEnd?: Date | null }>;
  }>;
  assignments?: Array<{ startDate: Date; endDate: Date }>;
}) {
  return {
    lodgeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        capacity: null,
        hutLeaderLookaheadDays: options.hutLeaderLookaheadDays,
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(options.bookings ?? []),
    },
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue(options.assignments ?? []),
    },
  };
}

describe("getUnassignedHutLeaderDates", () => {
  it("uses the configured hut-leader lookahead when no override is supplied", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };
    const today = dateOnly("2026-04-10");

    await expect(
      getUnassignedHutLeaderDates({
        db: buildDb({ hutLeaderLookaheadDays: 3, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([]);

    await expect(
      getUnassignedHutLeaderDates({
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today,
      }),
    ).resolves.toEqual([
      {
        date: "2026-04-15",
        bookingCount: 1,
        guestCount: 2,
      },
    ]);
  });

  it("restricts to an explicit {from,to} window (may include past nights) and ignores the stored lookahead", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        // Occupies nights 03-05 and 03-06 (checkOut is exclusive).
        { checkIn: dateOnly("2026-03-05"), checkOut: dateOnly("2026-03-07"), guests: [{}, {}] },
        // Occupies night 03-20.
        { checkIn: dateOnly("2026-03-20"), checkOut: dateOnly("2026-03-21"), guests: [{}] },
        // Outside the window — must not appear even though the mock returns it.
        { checkIn: dateOnly("2026-04-15"), checkOut: dateOnly("2026-04-16"), guests: [{}] },
      ],
      // 03-06 already has a leader, so it is not "needs a leader".
      assignments: [{ startDate: dateOnly("2026-03-06"), endDate: dateOnly("2026-03-06") }],
    });

    const result = await getUnassignedHutLeaderDates({
      db,
      from: dateOnly("2026-03-01"),
      to: dateOnly("2026-03-31"),
      // "today" is well after the window: a windowed call still reports history.
      today: dateOnly("2026-07-01"),
    });

    // A window skips the lookahead setting entirely.
    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual([
      { date: "2026-03-05", bookingCount: 1, guestCount: 2 },
      { date: "2026-03-20", bookingCount: 1, guestCount: 1 },
    ]);
  });

  it("ignores a partial window (only from, or only to) and falls back to the lookahead", async () => {
    const booking = {
      checkIn: dateOnly("2026-04-15"),
      checkOut: dateOnly("2026-04-16"),
      guests: [{}, {}],
    };

    await expect(
      getUnassignedHutLeaderDates({
        db: buildDb({ hutLeaderLookaheadDays: 6, bookings: [booking] }),
        today: dateOnly("2026-04-10"),
        from: dateOnly("2026-03-01"),
      }),
    ).resolves.toEqual([
      { date: "2026-04-15", bookingCount: 1, guestCount: 2 },
    ]);
  });

  it("lets an explicit lookahead override the stored setting", async () => {
    const db = buildDb({
      hutLeaderLookaheadDays: 3,
      bookings: [
        {
          checkIn: dateOnly("2026-04-15"),
          checkOut: dateOnly("2026-04-16"),
          guests: [{}],
        },
      ],
    });

    const result = await getUnassignedHutLeaderDates({
      db,
      today: dateOnly("2026-04-10"),
      lookAheadDays: 6,
    });

    expect(db.lodgeSettings.findUnique).not.toHaveBeenCalled();
    expect(result.map((item) => item.date)).toEqual(["2026-04-15"]);
  });
});
