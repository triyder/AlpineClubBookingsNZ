import { describe, expect, it } from "vitest";
import {
  calculateAppliedCreditRestore,
  type CancellationRule,
} from "@/lib/policies/cancellation";

/**
 * Unit tests for calculateAppliedCreditRestore (#1164 / decision D7): the slice a
 * member paid with account credit is restored on cancellation subject to the SAME
 * cancellation tier as the card slice, with the fixed cancellation fee charged once
 * per cancellation, card-first.
 *
 * Fixed worked values are asserted deliberately — a cross-equivalence property
 * (cardRestore + creditRestore === refund on the combined base) is NOT asserted
 * because the two slices round independently and can differ by up to 1 cent.
 */
describe("calculateAppliedCreditRestore", () => {
  const tier = (
    daysBeforeStay: number,
    refundPercentage: number,
    fixedFeeCents = 0
  ): CancellationRule => ({ daysBeforeStay, refundPercentage, fixedFeeCents });

  it("restores the full applied credit at a 100% tier", () => {
    const rules = [tier(14, 100), tier(0, 0)];
    expect(calculateAppliedCreditRestore(5000, 0, 30, rules)).toEqual({
      creditRestoredCents: 5000,
      creditRestorePercentage: 100,
    });
  });

  it("restores half the applied credit at a 50% tier", () => {
    const rules = [tier(7, 50), tier(0, 0)];
    expect(calculateAppliedCreditRestore(4000, 0, 10, rules)).toEqual({
      creditRestoredCents: 2000,
      creditRestorePercentage: 50,
    });
  });

  it("rounds the tiered credit slice (half rounds up)", () => {
    const rules = [tier(7, 50), tier(0, 0)];
    // 999 * 50% = 499.5 -> Math.round -> 500
    expect(calculateAppliedCreditRestore(999, 0, 10, rules).creditRestoredCents).toBe(
      500
    );
  });

  it("restores nothing at a 0% tier", () => {
    const rules = [tier(7, 50), tier(0, 0)];
    expect(calculateAppliedCreditRestore(5000, 0, 1, rules)).toEqual({
      creditRestoredCents: 0,
      creditRestorePercentage: 0,
    });
  });

  it("charges the fixed fee once, card-first: a mixed booking's card slice absorbs the whole fee", () => {
    const rules = [tier(7, 50, 1000), tier(0, 0)];
    // cardGross = 8000 * 50% = 4000 >= 1000 fee -> feeRemainder 0.
    // creditGross = 2000 * 50% = 1000, nothing deducted from the credit slice.
    expect(
      calculateAppliedCreditRestore(2000, 8000, 10, rules).creditRestoredCents
    ).toBe(1000);
  });

  it("splits the fixed fee when the card slice only partly absorbs it", () => {
    const rules = [tier(7, 50, 1000), tier(0, 0)];
    // cardGross = 1000 * 50% = 500 -> feeRemainder 500.
    // creditGross = 4000 * 50% = 2000, minus 500 remainder = 1500.
    expect(
      calculateAppliedCreditRestore(4000, 1000, 10, rules).creditRestoredCents
    ).toBe(1500);
  });

  it("makes a credit-only booking's credit slice absorb the whole fee", () => {
    const rules = [tier(7, 50, 1000), tier(0, 0)];
    // No card slice: cardGross 0 -> feeRemainder = full 1000 fee.
    // creditGross = 4000 * 50% = 2000, minus 1000 = 1000.
    expect(
      calculateAppliedCreditRestore(4000, 0, 10, rules).creditRestoredCents
    ).toBe(1000);
  });

  it("never goes negative when the fee exceeds the tiered credit slice", () => {
    const rules = [tier(7, 50, 3000), tier(0, 0)];
    // creditGross = 4000 * 50% = 2000, feeRemainder 3000 -> clamped to 0.
    expect(
      calculateAppliedCreditRestore(4000, 0, 10, rules).creditRestoredCents
    ).toBe(0);
  });

  it("returns zero for a zero applied-credit slice", () => {
    const rules = [tier(14, 100), tier(0, 0)];
    expect(calculateAppliedCreditRestore(0, 8000, 30, rules)).toEqual({
      creditRestoredCents: 0,
      creditRestorePercentage: 0,
    });
  });

  it("is monotonic non-decreasing in days for a sensible descending-tier policy", () => {
    // A realistic policy where later cancellation restores less. (Monotonicity
    // is asserted on a fixed sensible policy, not over arbitrary policies, since
    // getRefundTier lets a non-monotonic policy invert the relationship.)
    const rules = [tier(14, 100), tier(7, 50), tier(0, 0)];
    const restore = (days: number) =>
      calculateAppliedCreditRestore(4000, 0, days, rules).creditRestoredCents;
    expect(restore(30)).toBe(4000);
    expect(restore(10)).toBe(2000);
    expect(restore(3)).toBe(0);
    expect(restore(30)).toBeGreaterThanOrEqual(restore(10));
    expect(restore(10)).toBeGreaterThanOrEqual(restore(3));
  });
});
