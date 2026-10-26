import { describe, expect, it } from "vitest";

import { promoBreakdownLines } from "@/lib/booking-edit-promo-lines";

/**
 * #4197: the promo lines of a booking edit's breakdown. Outside the in-progress
 * and refused cases, the lines always sum to the new adjustment less the stored
 * one, which is the promotion's share of `priceDiffCents`.
 */
const base = {
  carriedOver: false,
  refused: false,
  storedCodes: "SPRING10" as string | null,
  storedAdjustmentCents: -2_500,
  appliedCodes: "SPRING10" as string | null,
  newAdjustmentCents: -3_000,
};
const sum = (lines: ReadonlyArray<{ amountCents: number }>) =>
  lines.reduce((total, line) => total + line.amountCents, 0);

describe("promoBreakdownLines (#4197)", () => {
  it("an in-progress edit carries the adjustment over with no lines", () => {
    expect(promoBreakdownLines({ ...base, carriedOver: true })).toEqual([]);
  });

  it("a kept code set is one net line", () => {
    expect(promoBreakdownLines(base)).toEqual([
      { label: "Promo 'SPRING10' (re-priced)", amountCents: -500 },
    ]);
  });

  it("a kept code set that nets to nothing has no line", () => {
    expect(promoBreakdownLines({ ...base, newAdjustmentCents: -2_500 })).toEqual([]);
  });

  it("an adjustment that goes to nothing with the code gone is a removal, removed or lapsed", () => {
    expect(
      promoBreakdownLines({ ...base, appliedCodes: null, newAdjustmentCents: 0 }),
    ).toEqual([{ label: "Removed promo 'SPRING10'", amountCents: 2_500 }]);
  });

  it("a kept code that now discounts nothing is re-priced, not removed", () => {
    expect(promoBreakdownLines({ ...base, newAdjustmentCents: 0 })).toEqual([
      { label: "Promo 'SPRING10' (re-priced)", amountCents: 2_500 },
    ]);
  });

  it("one code lapsing beside a kept one: the kept code's line and the old pair reversed", () => {
    const lines = promoBreakdownLines({
      ...base,
      storedCodes: "SPRING10, GUESTFREE",
      storedAdjustmentCents: -3_000,
      appliedCodes: "SPRING10",
      newAdjustmentCents: -1_000,
    });
    expect(lines).toEqual([
      { label: "Promo 'SPRING10'", amountCents: -1_000 },
      { label: "Previous promo 'SPRING10, GUESTFREE' reversed", amountCents: 3_000 },
    ]);
    expect(sum(lines)).toBe(2_000);
  });

  it("a replaced code is the new line and the previous one reversed", () => {
    const lines = promoBreakdownLines({ ...base, appliedCodes: "MATES50", newAdjustmentCents: -5_000 });
    expect(lines).toEqual([
      { label: "Promo 'MATES50'", amountCents: -5_000 },
      { label: "Previous promo 'SPRING10' reversed", amountCents: 2_500 },
    ]);
    expect(sum(lines)).toBe(-5_000 - -2_500);
  });

  it("a new code on a booking with none is its line alone", () => {
    expect(
      promoBreakdownLines({
        ...base,
        storedCodes: null,
        storedAdjustmentCents: 0,
        appliedCodes: "MATES50",
        newAdjustmentCents: -5_000,
      }),
    ).toEqual([{ label: "Promo 'MATES50'", amountCents: -5_000 }]);
  });

  it("an adjustment with no redemption row naming a code is called a promo adjustment, unquoted", () => {
    expect(
      promoBreakdownLines({ ...base, storedCodes: null, appliedCodes: null, newAdjustmentCents: 0 }),
    ).toEqual([{ label: "Removed promo adjustment", amountCents: 2_500 }]);
    expect(
      promoBreakdownLines({ ...base, storedCodes: null, appliedCodes: "MATES50", newAdjustmentCents: -5_000 }),
    ).toEqual([
      { label: "Promo 'MATES50'", amountCents: -5_000 },
      { label: "Previous promo adjustment reversed", amountCents: 2_500 },
    ]);
  });

  it("a refused code keeps the stored adjustment, so it has no line", () => {
    expect(
      promoBreakdownLines({ ...base, refused: true, appliedCodes: null, newAdjustmentCents: -2_500 }),
    ).toEqual([]);
  });

  it("every case outside the in-progress and refused ones sums to the adjustment's change", () => {
    const codes = [null, "SPRING10", "MATES50"];
    const amounts = [0, -2_500, -5_000, 1_000];
    for (const storedCodes of codes)
      for (const appliedCodes of codes)
        for (const storedAdjustmentCents of amounts)
          for (const newAdjustmentCents of amounts) {
            const input = { ...base, storedCodes, appliedCodes, storedAdjustmentCents, newAdjustmentCents };
            expect(sum(promoBreakdownLines(input))).toBe(newAdjustmentCents - storedAdjustmentCents);
          }
  });
});
