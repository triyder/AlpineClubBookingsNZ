import { describe, it, expect } from "vitest";
import { shouldIncludeRecurrence } from "@/lib/calendar-client";

// Regression guard for #calendar-recurring: a create used scope "single" and the
// old guard `repeat === "NONE" || scope === "single"` swallowed the recurrence
// rule on EVERY create, so a "repeat monthly" event was stored as a single
// occurrence. These lock the corrected decision.
describe("shouldIncludeRecurrence", () => {
  it("includes the rule when CREATING a recurring event (the regression)", () => {
    expect(
      shouldIncludeRecurrence({
        repeat: "MONTHLY_NTH_WEEKDAY",
        isEdit: false,
        isSeriesEvent: false,
        scope: "single",
      }),
    ).toBe(true);
  });

  it("omits the rule when repeat is NONE", () => {
    expect(
      shouldIncludeRecurrence({
        repeat: "NONE",
        isEdit: false,
        isSeriesEvent: false,
        scope: "single",
      }),
    ).toBe(false);
  });

  it("includes the rule when converting a standalone event to recurring", () => {
    expect(
      shouldIncludeRecurrence({
        repeat: "WEEKLY",
        isEdit: true,
        isSeriesEvent: false,
        scope: "single",
      }),
    ).toBe(true);
  });

  it("drops the rule when editing a SINGLE occurrence of a series", () => {
    expect(
      shouldIncludeRecurrence({
        repeat: "WEEKLY",
        isEdit: true,
        isSeriesEvent: true,
        scope: "single",
      }),
    ).toBe(false);
  });

  it("includes the rule on a whole-series edit", () => {
    expect(
      shouldIncludeRecurrence({
        repeat: "WEEKLY",
        isEdit: true,
        isSeriesEvent: true,
        scope: "series",
      }),
    ).toBe(true);
  });
});
