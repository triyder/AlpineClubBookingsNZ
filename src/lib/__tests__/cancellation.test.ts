import { describe, it, expect } from "vitest";

// getRefundTier / calculateRefundAmount are re-implemented below to avoid
// importing "../cancellation", which pulls in prisma. daysUntilDate is imported
// straight from the prisma-free policy module so these tests exercise the real
// NZ-lodge-day boundary logic (issue #1166) rather than a stale copy.
import { daysUntilDate } from "../policies/cancellation";
import type { CancellationRule } from "../cancellation";

function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundPercentage: number; creditRefundPercentage: number; daysBeforeStay: number } {
  if (policyRules.length === 0) {
    return { refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return {
        refundPercentage: rule.refundPercentage,
        creditRefundPercentage: rule.creditRefundPercentage ?? rule.refundPercentage,
        daysBeforeStay: rule.daysBeforeStay,
      };
    }
  }

  return { refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 };
}

function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { refundAmountCents: number; refundPercentage: number } {
  const { refundPercentage } = getRefundTier(daysUntilCheckIn, policyRules);
  const refundAmountCents = Math.round(
    (paidAmountCents * refundPercentage) / 100
  );
  return { refundAmountCents, refundPercentage };
}

const standardPolicy: CancellationRule[] = [
  { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
  { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];

describe("getRefundTier", () => {
  it("returns 100% for 15 days before (above highest tier)", () => {
    expect(getRefundTier(15, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });

  it("returns 100% for exactly 14 days (exact boundary)", () => {
    expect(getRefundTier(14, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });

  it("returns 50% for 10 days (between tiers)", () => {
    expect(getRefundTier(10, standardPolicy)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 50% for exactly 7 days (exact boundary)", () => {
    expect(getRefundTier(7, standardPolicy)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 0% for 5 days (below 7-day tier)", () => {
    expect(getRefundTier(5, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns 0% for 0 days (exact lowest boundary)", () => {
    expect(getRefundTier(0, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns 0% for empty policy", () => {
    expect(getRefundTier(15, [])).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("handles single-rule policy", () => {
    expect(
      getRefundTier(5, [{ daysBeforeStay: 3, refundPercentage: 75, creditRefundPercentage: 75 }])
    ).toEqual({ refundPercentage: 75, creditRefundPercentage: 75, daysBeforeStay: 3 });
  });

  it("returns 0% when below single-rule threshold", () => {
    expect(
      getRefundTier(2, [{ daysBeforeStay: 3, refundPercentage: 75, creditRefundPercentage: 75 }])
    ).toEqual({ refundPercentage: 0, creditRefundPercentage: 0, daysBeforeStay: 0 });
  });

  it("handles unsorted policy rules", () => {
    const unsorted: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    expect(getRefundTier(10, unsorted)).toEqual({
      refundPercentage: 50,
      creditRefundPercentage: 50,
      daysBeforeStay: 7,
    });
  });

  it("returns 0% for negative days", () => {
    expect(getRefundTier(-1, standardPolicy)).toEqual({
      refundPercentage: 0,
      creditRefundPercentage: 0,
      daysBeforeStay: 0,
    });
  });

  it("returns highest tier for very large days", () => {
    expect(getRefundTier(365, standardPolicy)).toEqual({
      refundPercentage: 100,
      creditRefundPercentage: 100,
      daysBeforeStay: 14,
    });
  });
});

describe("calculateRefundAmount", () => {
  it("returns 100% refund when cancelling 14+ days before", () => {
    const result = calculateRefundAmount(10000, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 100% refund when cancelling 20 days before", () => {
    const result = calculateRefundAmount(10000, 20, standardPolicy);
    expect(result.refundAmountCents).toBe(10000);
    expect(result.refundPercentage).toBe(100);
  });

  it("returns 50% refund when cancelling 7-13 days before", () => {
    const result = calculateRefundAmount(10000, 7, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 50% refund when cancelling 10 days before", () => {
    const result = calculateRefundAmount(10000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("returns 0% refund when cancelling less than 7 days before", () => {
    const result = calculateRefundAmount(10000, 6, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling on the day", () => {
    const result = calculateRefundAmount(10000, 0, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("returns 0% refund when cancelling after check-in (negative days)", () => {
    const result = calculateRefundAmount(10000, -1, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles empty policy (no refund)", () => {
    const result = calculateRefundAmount(10000, 30, []);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it("handles single rule policy", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("correctly rounds refund amounts for odd percentages", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33, creditRefundPercentage: 33 },
    ];
    const result = calculateRefundAmount(10000, 5, policy);
    expect(result.refundAmountCents).toBe(3300);
    expect(result.refundPercentage).toBe(33);
  });

  it("correctly rounds fractional cents", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 33, creditRefundPercentage: 33 },
    ];
    // 333 * 33 / 100 = 109.89 -> rounds to 110
    const result = calculateRefundAmount(333, 5, policy);
    expect(result.refundAmountCents).toBe(110);
  });

  it("handles unsorted policy rules correctly", () => {
    const unsortedPolicy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50 },
    ];
    const result = calculateRefundAmount(10000, 10, unsortedPolicy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles generous policy (always 100%)", () => {
    const policy: CancellationRule[] = [
      { daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100 },
    ];
    const result = calculateRefundAmount(5000, 1, policy);
    expect(result.refundAmountCents).toBe(5000);
    expect(result.refundPercentage).toBe(100);
  });

  it("refunds based on paid amount after partial refunds", () => {
    const result = calculateRefundAmount(7000, 10, standardPolicy);
    expect(result.refundAmountCents).toBe(3500);
    expect(result.refundPercentage).toBe(50);
  });

  it("handles zero amount gracefully", () => {
    const result = calculateRefundAmount(0, 14, standardPolicy);
    expect(result.refundAmountCents).toBe(0);
    expect(result.refundPercentage).toBe(100);
  });
});

describe("daysUntilDate", () => {
  it("calculates days correctly for future date", () => {
    const now = new Date("2025-07-01T12:00:00Z");
    const checkIn = new Date("2025-07-15T12:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(14);
  });

  it("returns 0 for same day", () => {
    const now = new Date("2025-07-01T12:00:00Z");
    const checkIn = new Date("2025-07-01T23:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(0);
  });

  it("returns negative for past date", () => {
    const now = new Date("2025-07-15T12:00:00Z");
    const checkIn = new Date("2025-07-10T12:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(-5);
  });

  it("handles exact day boundary", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const checkIn = new Date("2025-07-08T00:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(7);
  });

  it("counts whole NZ lodge days regardless of intra-day times", () => {
    // NZST (UTC+12): 18:00Z is 06:00 on 2 Jul NZ; 06:00Z is 18:00 on 8 Jul NZ.
    // Six NZ calendar days apart (2 Jul -> 8 Jul), not the raw 6.5 wall-clock days.
    const now = new Date("2025-07-01T18:00:00Z");
    const checkIn = new Date("2025-07-08T06:00:00Z");
    expect(daysUntilDate(checkIn, now)).toBe(6);
  });

  it("keeps the 7-day tier for the whole NZ boundary day", () => {
    // NZST (UTC+12): 11:00Z is 23:00 on 1 Jul NZ; 11:30Z is 23:30 on 8 Jul NZ.
    // Seven NZ lodge days apart, so the 7-day tier (50%) applies.
    const now = new Date("2025-07-01T11:00:00Z");
    const checkIn = new Date("2025-07-08T11:30:00Z");
    const days = daysUntilDate(checkIn, now);
    expect(days).toBe(7);
    // Should get the 7-day tier, not below it
    expect(getRefundTier(days, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 50, daysBeforeStay: 7 })
    );
  });

  it("drops to the lower tier once the NZ day count falls below the threshold", () => {
    // NZST (UTC+12): 12:00Z is 00:00 on 2 Jul NZ; 11:00Z is 23:00 on 8 Jul NZ.
    // Six NZ lodge days apart, one short of the 7-day tier, so 0% applies.
    const now = new Date("2025-07-01T12:00:00Z");
    const checkIn = new Date("2025-07-08T11:00:00Z");
    const days = daysUntilDate(checkIn, now);
    expect(days).toBe(6);
    expect(getRefundTier(days, standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 0, daysBeforeStay: 0 })
    );
  });
});

// Issue #1166: the refund-tier boundary is counted in NZ lodge days, so it
// falls at NZ-local midnight (matching the member-visible "N days before
// check-in" countdown) rather than at UTC-midnight-of-check-in minus N*24h.
// TZ is left unset (repo convention) so APP_TIME_ZONE resolves to
// Pacific/Auckland. In each case `checkIn` is a date-only value (UTC midnight
// of the NZ lodge date) and `now` is chosen so the NZ-local calendar date, or
// the raw wall-clock ms, would disagree with the NZ-day answer.
describe("daysUntilDate — NZ lodge-day boundary (issue #1166)", () => {
  it("NZDT (summer, UTC+13): a late NZ evening on the boundary date keeps the 7-day tier", () => {
    // 2026-01-13T09:00Z is 22:00 on 13 Jan in NZ (NZDT). The member countdown
    // still reads 7 days (13 Jan -> 20 Jan), so the 50% tier applies. The old
    // raw-ms diff was 6.6 days -> floor 6 -> wrongly dropped to the 0% tier.
    const now = new Date("2026-01-13T09:00:00.000Z");
    const checkIn = new Date("2026-01-20T00:00:00.000Z");
    expect(daysUntilDate(checkIn, now)).toBe(7);
    expect(getRefundTier(daysUntilDate(checkIn, now), standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 50, daysBeforeStay: 7 })
    );
  });

  it("NZST (winter, UTC+12): a late NZ evening on the boundary date keeps the 7-day tier", () => {
    // 2025-07-13T10:00Z is 22:00 on 13 Jul in NZ (NZST). Same NZ-day count of
    // 7; the old raw-ms diff was 6.6 days -> floor 6 -> wrong 0% tier.
    const now = new Date("2025-07-13T10:00:00.000Z");
    const checkIn = new Date("2025-07-20T00:00:00.000Z");
    expect(daysUntilDate(checkIn, now)).toBe(7);
    expect(getRefundTier(daysUntilDate(checkIn, now), standardPolicy)).toEqual(
      expect.objectContaining({ refundPercentage: 50, daysBeforeStay: 7 })
    );
  });

  it("NZDT: an early NZ morning counts from the NZ date, not the earlier UTC date", () => {
    // 2026-01-13T13:00Z is 02:00 on 14 Jan in NZ — the NZ calendar date is a
    // day ahead of the UTC date (13 Jan). Counting from the NZ date gives 6;
    // counting from the UTC date would wrongly give 7.
    const now = new Date("2026-01-13T13:00:00.000Z");
    const checkIn = new Date("2026-01-20T00:00:00.000Z");
    expect(daysUntilDate(checkIn, now)).toBe(6);
  });

  it("NZST: an early NZ morning counts from the NZ date, not the earlier UTC date", () => {
    // 2025-07-13T13:00Z is 01:00 on 14 Jul in NZ (NZST). NZ date is 14 Jul,
    // UTC date is 13 Jul; NZ counting gives 6, the UTC date would give 7.
    const now = new Date("2025-07-13T13:00:00.000Z");
    const checkIn = new Date("2025-07-20T00:00:00.000Z");
    expect(daysUntilDate(checkIn, now)).toBe(6);
  });

  it("any time on the same NZ calendar day yields the same whole-day count", () => {
    // 00:30 and 23:30 on 13 Jan NZ (NZDT) are the same NZ lodge day, so both
    // are 7 days before the 20 Jan check-in. The old raw-ms diff split them
    // across the boundary (7 vs 6), landing identical bookings in different
    // refund tiers purely on the time of day.
    const checkIn = new Date("2026-01-20T00:00:00.000Z");
    const earlyNzDay = new Date("2026-01-12T11:30:00.000Z"); // 00:30 on 13 Jan NZ
    const lateNzDay = new Date("2026-01-13T10:30:00.000Z"); // 23:30 on 13 Jan NZ
    expect(daysUntilDate(checkIn, earlyNzDay)).toBe(7);
    expect(daysUntilDate(checkIn, lateNzDay)).toBe(7);
    expect(daysUntilDate(checkIn, earlyNzDay)).toBe(
      daysUntilDate(checkIn, lateNzDay)
    );
  });
});
