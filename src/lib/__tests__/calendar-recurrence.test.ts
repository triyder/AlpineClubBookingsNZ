import { describe, it, expect } from "vitest";
import {
  generateOccurrenceStarts,
  recurrenceOptionsForDate,
  describeRecurrence,
  weekdayOrdinalInMonth,
  type RecurrenceRule,
} from "@/lib/calendar-recurrence";

// Anchors are built with local component APIs to match the generator's own
// local-time stepping, so these assertions hold regardless of the runner's TZ.

function ymd(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

describe("generateOccurrenceStarts — weekly", () => {
  it("produces N weekly occurrences on the same weekday", () => {
    const anchor = new Date(2026, 6, 21, 19, 0); // 21 Jul 2026, 7pm
    const rule: RecurrenceRule = {
      frequency: "WEEKLY",
      interval: 1,
      endMode: "count",
      count: 4,
    };
    const starts = generateOccurrenceStarts(anchor, rule);
    expect(starts).toHaveLength(4);
    starts.forEach((s, i) => {
      expect(s.getDay()).toBe(anchor.getDay());
      const expected = new Date(2026, 6, 21 + 7 * i);
      expect(ymd(s)).toEqual(ymd(expected));
      expect(s.getHours()).toBe(19); // wall-clock time preserved
    });
  });

  it("honours an interval of 2 (fortnightly)", () => {
    const anchor = new Date(2026, 6, 21, 9, 0);
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "WEEKLY",
      interval: 2,
      endMode: "count",
      count: 3,
    });
    expect(ymd(starts[1])).toEqual(ymd(new Date(2026, 6, 21 + 14)));
    expect(ymd(starts[2])).toEqual(ymd(new Date(2026, 6, 21 + 28)));
  });
});

describe("generateOccurrenceStarts — monthly by day of month", () => {
  it("repeats on the same day number", () => {
    const anchor = new Date(2026, 6, 15, 18, 30);
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "MONTHLY_DAY_OF_MONTH",
      interval: 1,
      endMode: "count",
      count: 3,
    });
    expect(ymd(starts[0])).toEqual([2026, 6, 15]);
    expect(ymd(starts[1])).toEqual([2026, 7, 15]);
    expect(ymd(starts[2])).toEqual([2026, 8, 15]);
  });

  it("clamps the 31st into shorter months instead of rolling over", () => {
    const anchor = new Date(2027, 0, 31, 12, 0); // 31 Jan 2027 (not a leap year)
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "MONTHLY_DAY_OF_MONTH",
      interval: 1,
      endMode: "count",
      count: 3,
    });
    expect(ymd(starts[0])).toEqual([2027, 0, 31]);
    expect(ymd(starts[1])).toEqual([2027, 1, 28]); // Feb clamps to 28
    expect(ymd(starts[2])).toEqual([2027, 2, 31]);
  });
});

describe("generateOccurrenceStarts — monthly by nth weekday", () => {
  it("repeats on the same nth weekday each month (3rd Tuesday)", () => {
    const anchor = new Date(2026, 6, 21, 19, 0); // 3rd Tuesday of Jul 2026
    const nth = weekdayOrdinalInMonth(anchor);
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "MONTHLY_NTH_WEEKDAY",
      interval: 1,
      endMode: "count",
      count: 6,
    });
    expect(starts).toHaveLength(6);
    for (const s of starts) {
      expect(s.getDay()).toBe(anchor.getDay());
      expect(weekdayOrdinalInMonth(s)).toBe(nth);
    }
  });
});

describe("generateOccurrenceStarts — end conditions", () => {
  it("stops at an inclusive until date", () => {
    const anchor = new Date(2026, 6, 1, 9, 0);
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "WEEKLY",
      interval: 1,
      endMode: "until",
      until: new Date(2026, 6, 22, 12, 0).toISOString(), // 22 Jul
    });
    // 1, 8, 15, 22 Jul — the 29th is past the until day.
    expect(starts.map((s) => s.getDate())).toEqual([1, 8, 15, 22]);
  });

  it("caps an open-ended daily rule at the safety ceiling", () => {
    const anchor = new Date(2026, 0, 1, 9, 0);
    const starts = generateOccurrenceStarts(anchor, {
      frequency: "DAILY",
      interval: 1,
      endMode: "never",
    });
    expect(starts.length).toBeLessThanOrEqual(366);
    expect(starts.length).toBeGreaterThan(0);
  });
});

describe("recurrenceOptionsForDate", () => {
  it("lists NONE first and labels weekly by the date's weekday", () => {
    const date = new Date(2026, 6, 21); // a Tuesday
    const opts = recurrenceOptionsForDate(date);
    expect(opts[0].value).toBe("NONE");
    const weekly = opts.find((o) => o.value === "WEEKLY");
    expect(weekly?.label).toContain("Tuesday");
    const nth = opts.find((o) => o.value === "MONTHLY_NTH_WEEKDAY");
    expect(nth?.label).toContain("Tuesday");
  });
});

describe("describeRecurrence", () => {
  it("summarises interval and weekday", () => {
    const anchor = new Date(2026, 6, 21);
    expect(
      describeRecurrence(
        { frequency: "WEEKLY", interval: 1, endMode: "never" },
        anchor,
      ),
    ).toContain("Weekly on");
    expect(
      describeRecurrence(
        { frequency: "WEEKLY", interval: 2, endMode: "never" },
        anchor,
      ),
    ).toContain("Every 2 weeks");
  });
});
