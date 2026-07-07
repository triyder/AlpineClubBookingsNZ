import { getDefaultLodgeId, resolvePolicyRowsForLodge } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { getStayNights } from "@/lib/pricing";
import {
  validateMinimumStayWithPolicies,
  type MinimumStayViolation,
} from "@/lib/policies/minimum-stay";

export {
  // test seam
  formatViolationMessage,
  formatViolationsDetail,
} from "@/lib/policies/minimum-stay";
export type { MinimumStayViolation } from "@/lib/policies/minimum-stay";

/**
 * Validate booking dates against the minimum stay policies that apply at one
 * lodge. Policy resolution follows the club-wide-with-override rule: a lodge
 * with its own minimum-stay rows uses them instead of the club-wide set
 * (ADR-001 resolved question 3), so the whole active policy type is fetched
 * and resolved before date filtering. Callers without lodge context omit
 * lodgeId and get the club's default lodge.
 */
export async function validateMinimumStay(
  checkIn: Date,
  checkOut: Date,
  lodgeId?: string | null
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }> {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0) {
    return { valid: true, violations: [] };
  }

  const firstNight = nights[0];
  const lastNight = nights[nights.length - 1];

  const effectiveLodgeId = lodgeId ?? (await getDefaultLodgeId(prisma));

  // Fetch the whole active policy type for this lodge plus club-wide rows
  // (the table is small), resolve the override set, then date-filter.
  const allPolicies = await prisma.minimumStayPolicy.findMany({
    where: {
      active: true,
      OR: [{ lodgeId: effectiveLodgeId }, { lodgeId: null }],
    },
  });

  const policies = resolvePolicyRowsForLodge(allPolicies, effectiveLodgeId).filter(
    (policy) => policy.startDate <= lastNight && policy.endDate >= firstNight
  );

  if (policies.length === 0) {
    return { valid: true, violations: [] };
  }

  return validateMinimumStayWithPolicies(checkIn, checkOut, policies);
}
