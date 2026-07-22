import { describe, expect, it } from "vitest";
import {
  MAX_BUDGET_CENTS,
  centsToDollars,
  parseDollarsToCents,
} from "../budget";

describe("centsToDollars", () => {
  it("formats integer cents as a 2dp dollar string", () => {
    expect(centsToDollars(0)).toBe("0.00");
    expect(centsToDollars(1000)).toBe("10.00");
    expect(centsToDollars(1234)).toBe("12.34");
    expect(centsToDollars(MAX_BUDGET_CENTS)).toBe("1000.00");
  });
});

describe("parseDollarsToCents", () => {
  it("parses valid dollars-and-cents to integer cents", () => {
    expect(parseDollarsToCents("10")).toEqual({ ok: true, cents: 1000 });
    expect(parseDollarsToCents("10.00")).toEqual({ ok: true, cents: 1000 });
    expect(parseDollarsToCents("12.34")).toEqual({ ok: true, cents: 1234 });
    expect(parseDollarsToCents("0")).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents("0.00")).toEqual({ ok: true, cents: 0 });
    expect(parseDollarsToCents(" 5.5 ")).toEqual({ ok: true, cents: 550 });
  });

  it("accepts the maximum but rejects above it", () => {
    expect(parseDollarsToCents("1000")).toEqual({
      ok: true,
      cents: MAX_BUDGET_CENTS,
    });
    expect(parseDollarsToCents("1000.01").ok).toBe(false);
    expect(parseDollarsToCents("5000").ok).toBe(false);
  });

  it("rejects blanks, non-numbers, negatives, and over-precise input", () => {
    expect(parseDollarsToCents("").ok).toBe(false);
    expect(parseDollarsToCents("   ").ok).toBe(false);
    expect(parseDollarsToCents("abc").ok).toBe(false);
    expect(parseDollarsToCents("-5").ok).toBe(false);
    expect(parseDollarsToCents("10.001").ok).toBe(false);
    expect(parseDollarsToCents("$10").ok).toBe(false);
  });
});
