import { describe, expect, it } from "vitest";
import { parseOptionalDateOnly } from "@/lib/finance-sync-xero-datasets/date-format";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// #2105 (from #2110 review): parseOptionalDateOnly must be Date-aware like its
// siblings. xero-node coerces `/Date(...)/` invoice date fields to JS Dates at
// runtime; before the fix a Date silently parsed to null, dropping the due date
// from the aging-bucket / days-overdue computation.
describe("parseOptionalDateOnly Date-awareness (#2105)", () => {
  it("returns null for empty inputs", () => {
    expect(parseOptionalDateOnly(null)).toBeNull();
    expect(parseOptionalDateOnly(undefined)).toBeNull();
    expect(parseOptionalDateOnly("")).toBeNull();
  });

  it("parses a date-only string", () => {
    expect(iso(parseOptionalDateOnly("2026-04-10"))).toBe("2026-04-10");
  });

  it("returns null for an unparseable string", () => {
    expect(parseOptionalDateOnly("not-a-date")).toBeNull();
  });

  it("normalizes a Date object to a date-only Date (was previously null)", () => {
    const result = parseOptionalDateOnly(new Date("2026-04-10T00:00:00.000Z"));
    expect(result).not.toBeNull();
    expect(iso(result)).toBe("2026-04-10");
  });

  it("treats an invalid Date object as unset rather than crashing", () => {
    expect(parseOptionalDateOnly(new Date(Number.NaN))).toBeNull();
  });
});
