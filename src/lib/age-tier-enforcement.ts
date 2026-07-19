import type { AgeTier } from "@prisma/client";
import {
  membershipTypeAgeExemption,
  type MembershipTypeAgeExemption,
} from "./membership-types";

// Shared age-tier enforcement (#2106).
//
// A member's stored `Member.ageTier` must stay consistent with two independent
// forces at EVERY write site that can touch it (member edit, self-service
// profile, delegated family details, seasonal-assignment save, roll-forward,
// bulk set-role). This single resolver decides the tier to persist so the rule
// can never drift between sites. Precedence, highest first:
//
//   1. org force            — organisation/school accounts (ORG access role or
//                             legacy SCHOOL role) are always N/A (#1440).
//   2. type force           — the member's CURRENT-season membership type is
//                             FORCED (allowed tiers == {N/A}); everyone on it is
//                             N/A.
//   3. manual N/A (ALLOWED) — an admin explicitly picked N/A and the type
//                             permits it (ALLOWED). A previously hand-picked N/A
//                             is preserved when nothing explicit is submitted.
//   4. person tier restore  — otherwise the member holds a real person tier:
//                             the explicit person pick, else the caller's
//                             precomputed `restorePersonTier` (DOB-derived when
//                             recomputing, else ADULT).
//
// Pure and DB-free: the caller resolves org-ness, the current-season type's
// exemption, and the person-tier fallback, then applies the returned tier.

export const NOT_APPLICABLE_TYPE_REJECTION_MESSAGE =
  "The N/A age tier applies only to organisation accounts and membership types configured to allow it.";

export type ResolveEnforcedAgeTierParams = {
  /** ORG access role (or legacy SCHOOL role) after this write. */
  isOrganisation: boolean;
  /**
   * Exemption of the member's current-season membership type, or null when the
   * member has no current-season assignment (no type force / no manual N/A).
   */
  typeExemption: MembershipTypeAgeExemption | null;
  /**
   * The age tier the write explicitly requests, when the caller carries a
   * user/admin selection (the member-edit dialog). `undefined`/`null` at
   * DOB-recompute sites, which never submit a tier directly.
   */
  requestedAgeTier?: AgeTier | null;
  /** Member's current stored tier (used to preserve a hand-picked N/A). */
  currentAgeTier: AgeTier;
  /**
   * The real person tier to persist when the member must hold one and no
   * explicit person tier was requested. The caller precomputes this: the
   * DOB-derived tier at recompute sites, the DOB-derived restore (else ADULT)
   * when un-forcing a previously-N/A member, or the member's current person
   * tier for an edit that does not touch age.
   */
  restorePersonTier: AgeTier;
};

export type ResolveEnforcedAgeTierResult =
  | { ok: true; ageTier: AgeTier }
  | { ok: false; error: string };

export function resolveEnforcedAgeTier(
  params: ResolveEnforcedAgeTierParams,
): ResolveEnforcedAgeTierResult {
  const {
    isOrganisation,
    typeExemption,
    requestedAgeTier,
    currentAgeTier,
    restorePersonTier,
  } = params;

  // 1. Org force — always N/A regardless of type, DOB or submitted tier.
  if (isOrganisation) {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 2. Type force — a FORCED (only-N/A) current-season type forces N/A.
  if (typeExemption === "FORCED") {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 3a. Explicit manual N/A request: only honoured when the type ALLOWS it.
  if (requestedAgeTier === "NOT_APPLICABLE") {
    if (typeExemption === "ALLOWED") {
      return { ok: true, ageTier: "NOT_APPLICABLE" };
    }
    return { ok: false, error: NOT_APPLICABLE_TYPE_REJECTION_MESSAGE };
  }

  // 3b. Explicit person tier wins (narrowed to a non-N/A tier by 3a above).
  if (requestedAgeTier) {
    return { ok: true, ageTier: requestedAgeTier };
  }

  // 3c. No explicit tier submitted. Preserve a previously hand-picked N/A while
  // the type still ALLOWS it (a DOB recompute must not silently un-set an
  // admin's manual N/A choice).
  if (currentAgeTier === "NOT_APPLICABLE" && typeExemption === "ALLOWED") {
    return { ok: true, ageTier: "NOT_APPLICABLE" };
  }

  // 4. Restore/keep a real person tier.
  return { ok: true, ageTier: restorePersonTier };
}

// DB helper: resolve the age-exemption of a member's CURRENT-season membership
// type (the type whose allowed tiers gate whether the member may hold N/A).
// Returns null when the member has no assignment for the season — no type force
// and no manual-N/A permission apply. Typed structurally so it accepts the
// prisma client or a transaction client.
export interface MemberSeasonTypeExemptionClient {
  seasonalMembershipAssignment: {
    findUnique(args: {
      where: {
        memberId_seasonYear: { memberId: string; seasonYear: number };
      };
      select: {
        membershipType: {
          select: { allowedAgeTiers: { select: { ageTier: true } } };
        };
      };
    }): Promise<{
      membershipType: { allowedAgeTiers: Array<{ ageTier: AgeTier }> };
    } | null>;
  };
}

export async function loadMemberCurrentSeasonTypeExemption(
  db: MemberSeasonTypeExemptionClient,
  memberId: string,
  seasonYear: number,
): Promise<MembershipTypeAgeExemption | null> {
  const assignment = await db.seasonalMembershipAssignment.findUnique({
    where: { memberId_seasonYear: { memberId, seasonYear } },
    select: {
      membershipType: {
        select: { allowedAgeTiers: { select: { ageTier: true } } },
      },
    },
  });
  if (!assignment) {
    return null;
  }
  return membershipTypeAgeExemption(
    assignment.membershipType.allowedAgeTiers.map((tier) => tier.ageTier),
  );
}
