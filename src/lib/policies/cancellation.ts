import { normalizeCancellationRule, type CancellationRuleLike } from "../cancellation-rules";
import { normalizeDateOnlyForTimeZone } from "../date-only";

export type CancellationRule = CancellationRuleLike;

/**
 * Determine which cancellation tier applies for a given number of days before check-in.
 * Returns the matching tier's refund percentage and days threshold.
 *
 * Policy rules are sorted by daysBeforeStay descending.
 * The first rule where daysUntilCheckIn >= daysBeforeStay applies.
 */
export function getRefundTier(
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  refundPercentage: number;
  creditRefundPercentage: number;
  fixedFeeCents: number;
  creditFixedFeeCents: number;
  daysBeforeStay: number;
} {
  if (policyRules.length === 0) {
    return {
      refundPercentage: 0,
      creditRefundPercentage: 0,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
      daysBeforeStay: 0,
    };
  }

  const sortedRules = [...policyRules].sort(
    (a, b) => b.daysBeforeStay - a.daysBeforeStay
  );

  for (const rule of sortedRules) {
    if (daysUntilCheckIn >= rule.daysBeforeStay) {
      return normalizeCancellationRule(rule);
    }
  }

  return {
    refundPercentage: 0,
    creditRefundPercentage: 0,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
    daysBeforeStay: 0,
  };
}

/**
 * Calculate refund amount based on cancellation policy.
 *
 * Example policy:
 *   [{days: 14, refund: 100}, {days: 7, refund: 50}, {days: 0, refund: 0}]
 *
 * - Cancel 15 days before -> 100% refund
 * - Cancel 10 days before -> 50% refund
 * - Cancel 3 days before -> 0% refund
 */
export function calculateRefundAmount(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[],
  refundMethod: "card" | "credit" = "card"
): { refundAmountCents: number; refundPercentage: number } {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  const refundPercentage =
    refundMethod === "credit"
      ? tier.creditRefundPercentage
      : tier.refundPercentage;
  const fixedFeeCents =
    refundMethod === "credit"
      ? tier.creditFixedFeeCents
      : tier.fixedFeeCents;
  const refundAmountCents = Math.max(
    0,
    Math.round((paidAmountCents * refundPercentage) / 100) - fixedFeeCents
  );
  return { refundAmountCents, refundPercentage };
}

/**
 * Refund amount for the slice a member originally paid with account credit, tiered by the
 * SAME cancellation tier as the card slice (#1164 / decision D7). The fixed cancellation fee is
 * charged once per cancellation, card-first: only the portion of the tier's fixedFeeCents the card
 * slice's gross did not absorb is taken from the credit slice, so a credit-only booking still pays
 * the fee and a mixed booking is not double-charged.
 */
export function calculateAppliedCreditRestore(
  creditAppliedCents: number,
  cardRefundableBaseCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): { creditRestoredCents: number; creditRestorePercentage: number } {
  if (creditAppliedCents <= 0) {
    return { creditRestoredCents: 0, creditRestorePercentage: 0 };
  }
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  const pct = tier.refundPercentage; // same tier as card
  const cardGross = Math.round((Math.max(0, cardRefundableBaseCents) * pct) / 100);
  const feeRemainder = Math.max(0, tier.fixedFeeCents - cardGross); // fee once, card-first
  const creditGross = Math.round((creditAppliedCents * pct) / 100);
  return {
    creditRestoredCents: Math.max(0, creditGross - feeRemainder),
    creditRestorePercentage: pct,
  };
}

/**
 * Calculate both card and credit refund amounts for a cancel preview.
 */
export function calculateDualRefundAmounts(
  paidAmountCents: number,
  daysUntilCheckIn: number,
  policyRules: CancellationRule[]
): {
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
} {
  const tier = getRefundTier(daysUntilCheckIn, policyRules);
  return {
    cardRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.refundPercentage) / 100) - tier.fixedFeeCents
    ),
    cardRefundPercentage: tier.refundPercentage,
    creditRefundAmountCents: Math.max(
      0,
      Math.round((paidAmountCents * tier.creditRefundPercentage) / 100) - tier.creditFixedFeeCents
    ),
    creditRefundPercentage: tier.creditRefundPercentage,
  };
}

/**
 * Days between `now` and `checkIn`, counted in NZ lodge days.
 *
 * Both operands are normalized to UTC-midnight of their NZ-local calendar date
 * (Pacific/Auckland via APP_TIME_ZONE), so the difference is a whole number of NZ
 * lodge days and the tier boundary falls at NZ-local midnight — matching the
 * member-visible "N days before check-in" countdown. UTC midnights are
 * DST-independent, so consecutive days are exactly 86_400_000 ms apart and the
 * result is already an integer; Math.floor is retained as a no-op safety that
 * preserves the deliberate "partial days do NOT reach a higher tier" intent
 * (documented above the previous implementation).
 *
 * Previously this used raw (checkIn - now) wall-clock ms, whose boundary sat at
 * UTC midnight of the check-in date minus N*24h — up to ~13h off NZ local time.
 */
export function daysUntilDate(checkIn: Date, now: Date = new Date()): number {
  const checkInDay = normalizeDateOnlyForTimeZone(checkIn);
  const nowDay = normalizeDateOnlyForTimeZone(now);
  return Math.floor((checkInDay.getTime() - nowDay.getTime()) / (1000 * 60 * 60 * 24));
}
