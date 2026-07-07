import { prisma } from "@/lib/prisma";
import { countMemberStayNights } from "@/lib/member-stay-nights";
import {
  loadMembershipNominationSettings,
  type MembershipNominationSettings,
} from "@/lib/membership-nomination-settings";

export interface NominatorEligibilityInput {
  gateEnabled: boolean;
  minimumMembershipMonths: number;
  minimumNights: number;
  gateEffectiveFrom: Date | null;
  /** Membership start date (joinedDate, falling back to createdAt). */
  membershipStart: Date | null;
  /** Whether the member has a completed induction. */
  inducted: boolean;
  /** Distinct nights the member has personally stayed. */
  nightsStayed: number;
  /** Evaluation reference time (defaults to now). */
  now?: Date;
}

export interface NominatorEligibilityResult {
  eligible: boolean;
  /** Human-readable reasons the member is not yet eligible (empty when eligible). */
  reasons: string[];
  details: {
    gateEnabled: boolean;
    grandfathered: boolean;
    inductionComplete: boolean;
    tenureMet: boolean;
    nightsMet: boolean;
    monthsServed: number | null;
    monthsRequired: number;
    nightsStayed: number;
    nightsRequired: number;
  };
}

// test seam
/** Whole completed months between two dates, using UTC to stay deterministic. */
export function monthsBetweenUtc(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) {
    months -= 1;
  }
  return months;
}

// test seam
/**
 * Pure evaluation of whether a member may nominate a new member. Kept free of IO
 * so it is straightforward to unit test.
 */
export function evaluateNominatorEligibility(
  input: NominatorEligibilityInput,
): NominatorEligibilityResult {
  const now = input.now ?? new Date();
  const monthsServed = input.membershipStart
    ? monthsBetweenUtc(input.membershipStart, now)
    : null;

  const grandfathered = Boolean(
    input.gateEffectiveFrom &&
      input.membershipStart &&
      input.membershipStart.getTime() < input.gateEffectiveFrom.getTime(),
  );

  // Gate off, or member predates the gate: always eligible.
  if (!input.gateEnabled || grandfathered) {
    return {
      eligible: true,
      reasons: [],
      details: {
        gateEnabled: input.gateEnabled,
        grandfathered,
        inductionComplete: true,
        tenureMet: true,
        nightsMet: true,
        monthsServed,
        monthsRequired: input.minimumMembershipMonths,
        nightsStayed: input.nightsStayed,
        nightsRequired: input.minimumNights,
      },
    };
  }

  const inductionComplete = input.inducted;
  const tenureMet =
    monthsServed !== null && monthsServed >= input.minimumMembershipMonths;
  const nightsMet = input.nightsStayed >= input.minimumNights;

  const reasons: string[] = [];
  if (!inductionComplete) {
    reasons.push("their lodge induction has not been signed off yet");
  }
  if (!tenureMet) {
    reasons.push(
      `they have not been a member for at least ${input.minimumMembershipMonths} months`,
    );
  }
  if (!nightsMet) {
    reasons.push(
      `they have not stayed at the lodge for at least ${input.minimumNights} nights`,
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    details: {
      gateEnabled: input.gateEnabled,
      grandfathered,
      inductionComplete,
      tenureMet,
      nightsMet,
      monthsServed,
      monthsRequired: input.minimumMembershipMonths,
      nightsStayed: input.nightsStayed,
      nightsRequired: input.minimumNights,
    },
  };
}

/** Whether the member has at least one completed induction record. */
async function isMemberInducted(memberId: string): Promise<boolean> {
  const count = await prisma.memberInduction.count({
    where: { memberId, status: "COMPLETED" },
  });
  return count > 0;
}

export interface NominatorMemberFacts {
  id: string;
  joinedDate: Date | null;
  createdAt: Date;
}

/**
 * Gather the live facts for a member and evaluate nomination eligibility. When
 * the gate is disabled or the member is grandfathered, no induction/nights work
 * is needed, so those queries are skipped.
 */
export async function checkNominatorEligibility(
  member: NominatorMemberFacts,
  settings?: MembershipNominationSettings,
): Promise<NominatorEligibilityResult> {
  const resolvedSettings = settings ?? (await loadMembershipNominationSettings());
  const membershipStart = member.joinedDate ?? member.createdAt;

  const grandfathered = Boolean(
    resolvedSettings.gateEffectiveFrom &&
      membershipStart.getTime() < resolvedSettings.gateEffectiveFrom.getTime(),
  );

  if (!resolvedSettings.gateEnabled || grandfathered) {
    return evaluateNominatorEligibility({
      gateEnabled: resolvedSettings.gateEnabled,
      minimumMembershipMonths: resolvedSettings.minimumMembershipMonths,
      minimumNights: resolvedSettings.minimumNights,
      gateEffectiveFrom: resolvedSettings.gateEffectiveFrom,
      membershipStart,
      inducted: true,
      nightsStayed: 0,
    });
  }

  const [inducted, nightsStayed] = await Promise.all([
    isMemberInducted(member.id),
    countMemberStayNights(member.id),
  ]);

  return evaluateNominatorEligibility({
    gateEnabled: resolvedSettings.gateEnabled,
    minimumMembershipMonths: resolvedSettings.minimumMembershipMonths,
    minimumNights: resolvedSettings.minimumNights,
    gateEffectiveFrom: resolvedSettings.gateEffectiveFrom,
    membershipStart,
    inducted,
    nightsStayed,
  });
}
