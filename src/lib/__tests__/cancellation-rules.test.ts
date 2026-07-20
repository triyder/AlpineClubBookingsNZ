import { describe, expect, it } from "vitest";
import {
  cancellationRuleSetsEqual,
  type CancellationRuleLike,
} from "@/lib/cancellation-rules";

// #2143: the booking-policy editors gate Save on this comparison, so a Save
// that changes nothing cannot reach a write route that logs an audit entry and
// revalidates the public pages unconditionally. A false "equal" would suppress
// a real save; a false "different" would let a no-op audit entry through.

const RULE = (
  daysBeforeStay: number,
  overrides: Partial<CancellationRuleLike> = {},
): CancellationRuleLike => ({
  daysBeforeStay,
  refundPercentage: 100,
  creditRefundPercentage: 100,
  fixedFeeCents: 0,
  creditFixedFeeCents: 0,
  ...overrides,
});

describe("cancellationRuleSetsEqual", () => {
  it("treats an identical set as equal", () => {
    expect(
      cancellationRuleSetsEqual([RULE(21), RULE(14)], [RULE(21), RULE(14)]),
    ).toBe(true);
  });

  it("ignores rule ORDER, because every write route sorts before storing", () => {
    expect(
      cancellationRuleSetsEqual([RULE(21), RULE(14)], [RULE(14), RULE(21)]),
    ).toBe(true);
  });

  it("normalises before comparing, so an omitted credit field equals its mirror", () => {
    // `normalizeCancellationRule` defaults creditRefundPercentage to the card
    // refund and creditFixedFeeCents to the card fee — which is what storage
    // holds, so the two spellings are the same stored row.
    const omitted: CancellationRuleLike = {
      daysBeforeStay: 7,
      refundPercentage: 50,
      fixedFeeCents: 2500,
    };
    const explicit: CancellationRuleLike = {
      daysBeforeStay: 7,
      refundPercentage: 50,
      creditRefundPercentage: 50,
      fixedFeeCents: 2500,
      creditFixedFeeCents: 2500,
    };
    expect(cancellationRuleSetsEqual([omitted], [explicit])).toBe(true);
  });

  it("treats a null credit field the same as an omitted one", () => {
    expect(
      cancellationRuleSetsEqual(
        [{ daysBeforeStay: 7, refundPercentage: 50, creditFixedFeeCents: null }],
        [{ daysBeforeStay: 7, refundPercentage: 50 }],
      ),
    ).toBe(true);
  });

  it("detects a changed threshold", () => {
    expect(cancellationRuleSetsEqual([RULE(21)], [RULE(20)])).toBe(false);
  });

  it("detects a changed refund percentage", () => {
    expect(
      cancellationRuleSetsEqual(
        [RULE(21)],
        [RULE(21, { refundPercentage: 90, creditRefundPercentage: 90 })],
      ),
    ).toBe(false);
  });

  it("detects a changed fixed fee, in integer cents", () => {
    expect(
      cancellationRuleSetsEqual(
        [RULE(21, { fixedFeeCents: 0, creditFixedFeeCents: 0 })],
        [RULE(21, { fixedFeeCents: 1, creditFixedFeeCents: 1 })],
      ),
    ).toBe(false);
  });

  it("detects a credit-only change that leaves the card refund identical", () => {
    expect(
      cancellationRuleSetsEqual(
        [RULE(21, { creditRefundPercentage: 100 })],
        [RULE(21, { creditRefundPercentage: 80 })],
      ),
    ).toBe(false);
  });

  it("detects an added or removed rule", () => {
    expect(cancellationRuleSetsEqual([RULE(21)], [RULE(21), RULE(14)])).toBe(
      false,
    );
    expect(cancellationRuleSetsEqual([RULE(21), RULE(14)], [RULE(21)])).toBe(
      false,
    );
  });

  it("treats two empty sets as equal", () => {
    expect(cancellationRuleSetsEqual([], [])).toBe(true);
  });

  it("does not mutate its inputs while sorting", () => {
    const a = [RULE(14), RULE(21)];
    cancellationRuleSetsEqual(a, [RULE(21), RULE(14)]);
    expect(a.map((rule) => rule.daysBeforeStay)).toEqual([14, 21]);
  });
});
