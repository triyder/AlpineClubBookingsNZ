import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  formatLocalDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
  todayDateOnlyForTimeZone,
} from "@/lib/date-only";

describe("date-only helpers", () => {
  it("parses a date-only string as UTC midnight", () => {
    expect(parseDateOnly("2026-04-16").toISOString()).toBe(
      "2026-04-16T00:00:00.000Z"
    );
  });

  it("formats Prisma-style date-only values without timezone drift", () => {
    expect(formatDateOnly(new Date("2026-04-16T00:00:00.000Z"))).toBe(
      "2026-04-16"
    );
  });

  it("formats local calendar dates without UTC timezone drift", () => {
    expect(formatLocalDateOnly(new Date(2026, 3, 30))).toBe("2026-04-30");
  });

  it("formats instants as New Zealand date-only values", () => {
    expect(
      formatDateOnlyForTimeZone(new Date("2026-04-29T12:00:00.000Z"))
    ).toBe("2026-04-30");
  });

  it("builds exact New Zealand calendar day boundaries", () => {
    expect(
      startOfDateOnlyForTimeZone("2026-04-30", "Pacific/Auckland").toISOString()
    ).toBe("2026-04-29T12:00:00.000Z");
    expect(
      endOfDateOnlyForTimeZone("2026-04-30", "Pacific/Auckland").toISOString()
    ).toBe("2026-04-30T11:59:59.999Z");
  });

  it("adds days in UTC so lodge dates stay aligned with @db.Date values", () => {
    expect(
      addDaysDateOnly(parseDateOnly("2026-04-16"), 1).toISOString()
    ).toBe("2026-04-17T00:00:00.000Z");
  });

  it("iterates date-only ranges without dropping the last day of the month", () => {
    const dates = eachDateOnlyInRange(
      parseDateOnly("2026-04-01"),
      parseDateOnly("2026-05-01")
    ).map(formatDateOnly);

    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-04-01");
    expect(dates.at(-1)).toBe("2026-04-30");
    expect(dates).not.toContain("2026-03-31");
  });

  it("derives today's NZ date as a date-only value", () => {
    expect(formatDateOnly(getTodayDateOnly("Pacific/Auckland"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });

  it("rejects impossible or malformed date-only strings", () => {
    expect(isDateOnlyString("not-a-date")).toBe(false);
    expect(isDateOnlyString("2026-02-31")).toBe(false);
    expect(Number.isNaN(parseDateOnly("2026-02-31").getTime())).toBe(true);
  });
});

describe("todayDateOnlyForTimeZone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the NZ (NZST) calendar date after NZ midnight even when UTC is still the previous day", () => {
    // 2026-07-07T13:00:00Z is 2026-07-08 01:00 in Pacific/Auckland (NZST, +12),
    // so a UTC (or any browser trailing NZ) clock would report 2026-07-07.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T13:00:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-07-08");
    // Sanity: the naive browser/UTC seed would have produced the earlier day.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-07");
  });

  it("honours NZDT (daylight saving, +13) when deriving the club date", () => {
    // 2026-01-05T11:30:00Z is 2026-01-06 00:30 in Pacific/Auckland (NZDT, +13).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T11:30:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-01-06");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("keeps the shared UTC calendar day when NZ has not yet rolled over", () => {
    // 2026-07-07T09:00:00Z is 2026-07-07 21:00 in Pacific/Auckland: same day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T09:00:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-07-07");
  });

  it("derives a valid date-only string using the configured app time zone by default", () => {
    // APP_TIME_ZONE resolves from the ambient TZ env, so assert the shape rather
    // than a specific zone to stay robust across CI clock configurations.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T13:00:00.000Z"));

    expect(todayDateOnlyForTimeZone()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
