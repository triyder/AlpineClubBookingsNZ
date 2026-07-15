import { describe, it, expect } from "vitest";
import { formatNZDate, formatNZDateTime } from "../nzst-date";

// The NZST "today"/"tomorrow" helpers were removed in #1878 (they parsed
// `${y}-${m}-${d}T00:00:00` in the server's LOCAL zone, shifting Prisma
// @db.Date comparisons a day back under the production TZ=Pacific/Auckland
// pin). Cron "today"/"tomorrow" coverage now lives in date-only.test.ts
// ("NZ cron date boundary (#1878)"). Only the display formatters remain here.
//
// 2026-04-15T23:30:00Z is 2026-04-16 11:30 in Pacific/Auckland (NZST, +12):
// the NZ calendar date differs from the UTC one, so these assertions fail if
// the formatters ever stop rendering in the club time zone.
const INSTANT = new Date("2026-04-15T23:30:00.000Z");

describe("formatNZDate", () => {
  it("renders the NZ calendar date, not the UTC date", () => {
    expect(formatNZDate(INSTANT)).toBe("16 Apr 2026");
  });
});

describe("formatNZDateTime", () => {
  it("renders the NZ-local date and time", () => {
    const formatted = formatNZDateTime(INSTANT);
    expect(formatted).toContain("16 Apr 2026");
    // \s tolerates the narrow no-break space some ICU versions emit.
    expect(formatted).toMatch(/11:30\sam/);
  });
});
