import { describe, expect, it } from "vitest";
import {
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";

describe("finance display formatters", () => {
  it("formats whole dollars with thousands separators and no cents", () => {
    expect(formatDollarsDisplay(44_667_484)).toBe("$446,675");
    expect(formatDollarsDisplay(123_456)).toBe("$1,235");
    expect(formatDollarsDisplay(49)).toBe("$0");
    expect(formatDollarsDisplay(-2_500_00)).toBe("-$2,500");
  });

  it("formats signed dollar deltas", () => {
    expect(formatSignedDollarsDisplay(120_400)).toBe("+$1,204");
    expect(formatSignedDollarsDisplay(-31_000)).toBe("-$310");
    expect(formatSignedDollarsDisplay(0)).toBe("$0");
    expect(formatSignedDollarsDisplay(20)).toBe("$0");
  });

  it("formats counts and percentages", () => {
    expect(formatFinanceNumber(12_345)).toBe("12,345");
    expect(formatFinanceSignedNumber(42)).toBe("+42");
    expect(formatFinanceSignedNumber(-7)).toBe("-7");
    expect(formatFinancePercent(0.125)).toBe("12.5%");
  });
});
