import { normalizeCancellationRule } from "./cancellation-rules";
import { prisma } from "./prisma";
import { type CancellationRule } from "./policies/cancellation";

export {
  calculateAppliedCreditRestore,
  calculateDualRefundAmounts,
  calculateRefundAmount,
  daysUntilDate,
  // test seam
  getRefundTier,
} from "./policies/cancellation";
export type { CancellationRule } from "./policies/cancellation";

type NonMemberHoldPolicySource = "period" | "default";

export type NonMemberHoldPolicy = {
  enabled: boolean;
  holdDays: number;
  source: NonMemberHoldPolicySource;
};

/**
 * Find the active BookingPeriod that covers a given check-in date, if any.
 */
async function getBookingPeriodForDate(checkIn: Date) {
  return prisma.bookingPeriod.findFirst({
    where: {
      active: true,
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
    },
  });
}

/**
 * Resolve the effective non-member hold policy for a check-in date.
 * Date-specific periods override both the hold enabled flag and the threshold.
 */
export async function getNonMemberHoldPolicy(
  checkIn: Date
): Promise<NonMemberHoldPolicy> {
  const period = await getBookingPeriodForDate(checkIn);
  if (period) {
    return {
      enabled: period.nonMemberHoldEnabled,
      holdDays: period.nonMemberHoldDays,
      source: "period",
    };
  }

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  });

  return {
    enabled: defaults?.nonMemberHoldEnabled ?? true,
    holdDays: defaults?.nonMemberHoldDays ?? 7,
    source: "default",
  };
}

/**
 * Get the non-member hold days for a given check-in date.
 * Uses period-specific value if check-in falls in a BookingPeriod,
 * otherwise uses the global default from BookingDefaults.
 *
 * Request-origin payment-link flows use this threshold as a deadline even when
 * member-created provisional holds are disabled.
 */
export async function getNonMemberHoldDays(checkIn: Date): Promise<number> {
  const policy = await getNonMemberHoldPolicy(checkIn);
  return policy.holdDays;
}

/**
 * Load the cancellation policy for a given check-in date.
 * If the check-in falls within an active BookingPeriod, uses that period's rules.
 * Otherwise falls back to the default CancellationPolicy table.
 */
export async function loadCancellationPolicy(
  checkIn?: Date
): Promise<CancellationRule[]> {
  if (checkIn) {
    const period = await getBookingPeriodForDate(checkIn);
    if (period) {
      const rawRules = period.cancellationRules as unknown as Array<{
        daysBeforeStay: number;
        refundPercentage: number;
        creditRefundPercentage?: number;
        fixedFeeCents?: number;
        creditFixedFeeCents?: number;
      }>;
      return rawRules
        .map(normalizeCancellationRule)
        .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
    }
  }

  const rules = await prisma.cancellationPolicy.findMany({
    orderBy: { daysBeforeStay: "desc" },
  });

  return rules.map(normalizeCancellationRule);
}
