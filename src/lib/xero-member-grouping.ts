/**
 * Xero member grouping — mode-driven resolution contract (E8, #1934).
 *
 * This module is the single source of truth for "which Xero contact group(s)
 * should a member be in". It replaces the age-tier-only mechanism
 * (`age-tier-xero-groups.ts` + the `AgeTierSetting.xeroContactGroup*` columns)
 * with a club-level MODE (None | Membership Type | Membership Type + Age) over
 * a single rule table (`XeroContactGroupRule`).
 *
 * The pure functions here (`resolveMemberGrouping`, `planMemberGroupingSync`)
 * take plain data and return decisions — no Prisma, no Xero — so the
 * mode × rule-shape × member-state matrix is exhaustively table-testable. The
 * DB loaders at the bottom read the mode/rules and resolve a member's effective
 * membership type via the ONE shared helper (`resolveMembershipTypePolicyForMember`,
 * E4 #1930) at the CURRENT season year, so grouping and pricing cannot diverge.
 *
 * Invariants:
 * - The system NEVER deletes a Xero contact group; it only adds/removes a
 *   contact's membership of groups referenced by ACTIVE rules ("managed
 *   universe"). Unlisted Xero groups are never touched.
 * - NONE mode is a total no-op: never add, never remove.
 * - Add-suppression: the matched MANAGED group is added only when the contact
 *   is currently in NONE of (matched MANAGED ∪ matched ACCEPTED) — members
 *   deliberately parked in an accepted group get no spurious add.
 */

import type { AgeTier, XeroContactGroupRuleMode, XeroMemberGroupingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveMembershipTypePolicyForMember,
  resolveMembershipTypePoliciesForMembers,
} from "@/lib/membership-type-policy";
import { getSeasonYear } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export interface XeroGroupingRule {
  membershipTypeId: string | null;
  ageTier: AgeTier | null;
  kind: XeroContactGroupRuleMode; // MANAGED | ACCEPTED
  groupId: string;
  groupName: string | null;
  sortOrder: number;
}

export interface XeroGroupRef {
  id: string;
  name: string | null;
}

export interface MemberGroupingResolution {
  mode: XeroMemberGroupingMode;
  /** The single MANAGED group the sync should ensure the member is in. */
  managedGroup: XeroGroupRef | null;
  /** Union of matched ACCEPTED groups + the matched MANAGED group. */
  acceptedGroupIds: string[];
  /**
   * groupIds the sync MAY remove the member from — every group referenced by
   * an active rule that is applicable under the current mode. Removal only ever
   * targets groups in this set that are not accepted for the member.
   */
  managedUniverse: string[];
  /** null when a MANAGED/ACCEPTED match exists; otherwise a skip reason. */
  skippedReason: "grouping_mode_none" | "no_matching_rule" | null;
}

export interface MemberGroupingSyncPlan {
  managedGroup: XeroGroupRef | null;
  /** The group to ADD (managed group, suppressed when already accepted-in). */
  groupToAdd: XeroGroupRef | null;
  /** groupIds to REMOVE the member from. */
  groupIdsToRemove: string[];
  skippedReason: MemberGroupingResolution["skippedReason"];
  /** true when neither an add nor a remove is required. */
  isNoop: boolean;
}

// ---------------------------------------------------------------------------
// Pure resolution
// ---------------------------------------------------------------------------

function ruleSpecificity(rule: XeroGroupingRule): number {
  return (rule.membershipTypeId !== null ? 2 : 0) + (rule.ageTier !== null ? 1 : 0);
}

/**
 * Whether a rule applies to a member under the given mode.
 * - MEMBERSHIP_TYPE: tier-bearing rules are inert (`ageTier` must be null); a
 *   rule matches when its (optional) membershipTypeId equals the member's type.
 * - MEMBERSHIP_TYPE_AND_AGE: the general match — type slot and tier slot each
 *   either unset (wildcard) or equal to the member's.
 */
function ruleMatchesMember(
  rule: XeroGroupingRule,
  mode: XeroMemberGroupingMode,
  membershipTypeId: string | null,
  ageTier: AgeTier | null,
): boolean {
  const typeMatch = rule.membershipTypeId === null || rule.membershipTypeId === membershipTypeId;
  if (mode === "MEMBERSHIP_TYPE") {
    return rule.ageTier === null && typeMatch;
  }
  // MEMBERSHIP_TYPE_AND_AGE
  const tierMatch = rule.ageTier === null || rule.ageTier === ageTier;
  return typeMatch && tierMatch;
}

/** groupIds referenced by active rules that are applicable under the mode. */
function computeManagedUniverse(
  mode: XeroMemberGroupingMode,
  activeRules: XeroGroupingRule[],
): string[] {
  if (mode === "NONE") {
    return [];
  }
  const universe = new Set<string>();
  for (const rule of activeRules) {
    // Tier-bearing rules are inert under MEMBERSHIP_TYPE — exclude their groups
    // from the removal universe so type-mode never strips an age-tier group.
    if (mode === "MEMBERSHIP_TYPE" && rule.ageTier !== null) {
      continue;
    }
    universe.add(rule.groupId);
  }
  return [...universe];
}

/**
 * Pure resolution of a member's expected grouping from the mode + active rules.
 * `activeRules` must already be filtered to isActive === true.
 */
export function resolveMemberGrouping(params: {
  mode: XeroMemberGroupingMode;
  membershipTypeId: string | null;
  ageTier: AgeTier | null;
  activeRules: XeroGroupingRule[];
}): MemberGroupingResolution {
  const { mode, membershipTypeId, ageTier, activeRules } = params;

  if (mode === "NONE") {
    return {
      mode,
      managedGroup: null,
      acceptedGroupIds: [],
      managedUniverse: [],
      skippedReason: "grouping_mode_none",
    };
  }

  const managedUniverse = computeManagedUniverse(mode, activeRules);

  const matching = activeRules.filter((rule) =>
    ruleMatchesMember(rule, mode, membershipTypeId, ageTier),
  );

  // Most-specific MANAGED match (type+tier > type-only > tier-only), ties broken
  // deterministically by sortOrder then groupId.
  const managedMatches = matching
    .filter((rule) => rule.kind === "MANAGED")
    .sort((left, right) => {
      const specDelta = ruleSpecificity(right) - ruleSpecificity(left);
      if (specDelta !== 0) return specDelta;
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.groupId.localeCompare(right.groupId);
    });
  const managedRule = managedMatches[0] ?? null;
  const managedGroup: XeroGroupRef | null = managedRule
    ? { id: managedRule.groupId, name: managedRule.groupName }
    : null;

  const acceptedGroupIds = new Set<string>();
  for (const rule of matching) {
    if (rule.kind === "ACCEPTED") {
      acceptedGroupIds.add(rule.groupId);
    }
  }
  if (managedGroup) {
    acceptedGroupIds.add(managedGroup.id);
  }

  const skippedReason =
    !managedGroup && acceptedGroupIds.size === 0 ? "no_matching_rule" : null;

  return {
    mode,
    managedGroup,
    acceptedGroupIds: [...acceptedGroupIds],
    managedUniverse,
    skippedReason,
  };
}

/**
 * Turn a resolution + the member's CURRENT Xero group membership into the
 * concrete add/remove plan. Preserves add-suppression: the managed group is
 * added only when the member is in none of its accepted groups.
 */
export function planMemberGroupingSync(params: {
  resolution: MemberGroupingResolution;
  currentGroupIds: string[];
}): MemberGroupingSyncPlan {
  const { resolution, currentGroupIds } = params;

  // Any skip reason (NONE mode, or member matches no rule) means zero Xero
  // writes — never a removal. Stale managed-group memberships of skipped
  // members surface as information-only entries in the dry-run snapshot
  // (getXeroMemberGroupingSnapshot().informational) for admin-driven cleanup,
  // never auto-removed.
  if (resolution.skippedReason) {
    return {
      managedGroup: resolution.managedGroup,
      groupToAdd: null,
      groupIdsToRemove: [],
      skippedReason: resolution.skippedReason,
      isNoop: true,
    };
  }

  const universe = new Set(resolution.managedUniverse);
  const accepted = new Set(resolution.acceptedGroupIds);
  const current = new Set(currentGroupIds);

  const groupIdsToRemove = [...current].filter(
    (id) => universe.has(id) && !accepted.has(id),
  );
  const alreadyInAccepted = [...current].some((id) => accepted.has(id));
  const groupToAdd =
    resolution.managedGroup && !alreadyInAccepted ? resolution.managedGroup : null;

  return {
    managedGroup: resolution.managedGroup,
    groupToAdd,
    groupIdsToRemove,
    skippedReason: null,
    isNoop: !groupToAdd && groupIdsToRemove.length === 0,
  };
}

// ---------------------------------------------------------------------------
// DB loaders
// ---------------------------------------------------------------------------

/** Reads the singleton grouping mode. Defaults to NONE when unset. */
export async function getXeroGroupingMode(): Promise<XeroMemberGroupingMode> {
  const settings = await prisma.xeroGroupingSettings.findUnique({
    where: { id: "default" },
    select: { mode: true },
  });
  return settings?.mode ?? "NONE";
}

/** Reads all ACTIVE rules, mapped to the pure {@link XeroGroupingRule} shape. */
export async function getActiveXeroGroupingRules(): Promise<XeroGroupingRule[]> {
  const rows = await prisma.xeroContactGroupRule.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      membershipTypeId: true,
      ageTier: true,
      mode: true,
      groupId: true,
      groupName: true,
      sortOrder: true,
    },
  });
  return rows.map((row) => ({
    membershipTypeId: row.membershipTypeId,
    ageTier: row.ageTier,
    kind: row.mode,
    groupId: row.groupId,
    groupName: row.groupName,
    sortOrder: row.sortOrder,
  }));
}

export interface XeroGroupingContext {
  mode: XeroMemberGroupingMode;
  activeRules: XeroGroupingRule[];
}

/** Loads the mode + active rules together (one call for a bulk run). */
export async function loadXeroGroupingContext(): Promise<XeroGroupingContext> {
  const [mode, activeRules] = await Promise.all([
    getXeroGroupingMode(),
    getActiveXeroGroupingRules(),
  ]);
  return { mode, activeRules };
}

/**
 * A member's effective membership type id for grouping — resolved via the ONE
 * shared policy helper (E4 #1930) at the CURRENT season year (`getSeasonYear(now)`),
 * the same no-assignment fallback as pricing. Grouping resolves at "now";
 * pricing resolves per stay-night season — this is the deliberate difference,
 * so the two consumers must not be merged.
 *
 * Returns null when the effective type has no DB row (built-in default
 * fallback), in which case no type-keyed rule can match it.
 */
export async function resolveEffectiveMembershipTypeId(
  memberId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const policy = await resolveMembershipTypePolicyForMember(prisma, {
    memberId,
    seasonYear: getSeasonYear(now),
  });
  return policy?.membershipType.id ?? null;
}

/**
 * Resolve a member's grouping using pre-loaded context. Resolves the member's
 * effective membership type only when the mode needs it (never in NONE).
 */
export async function resolveMemberGroupingForMember(params: {
  memberId: string;
  ageTier: AgeTier | null;
  context: XeroGroupingContext;
  now?: Date;
}): Promise<MemberGroupingResolution> {
  const { memberId, ageTier, context } = params;
  if (context.mode === "NONE") {
    return resolveMemberGrouping({
      mode: "NONE",
      membershipTypeId: null,
      ageTier,
      activeRules: context.activeRules,
    });
  }
  const membershipTypeId = await resolveEffectiveMembershipTypeId(
    memberId,
    params.now,
  );
  return resolveMemberGrouping({
    mode: context.mode,
    membershipTypeId,
    ageTier,
    activeRules: context.activeRules,
  });
}

/**
 * Batch resolution for many members (bulk re-sync + dry-run snapshot). Resolves
 * every member's effective membership type in ONE query via the shared batch
 * policy helper (E4 #1930) at the current season year, then applies the pure
 * resolution. Under NONE, returns NONE resolutions without touching the policy.
 */
export async function resolveMemberGroupingsForMembers(params: {
  members: Array<{ id: string; ageTier: AgeTier | null }>;
  context: XeroGroupingContext;
  now?: Date;
}): Promise<Map<string, MemberGroupingResolution>> {
  const { members, context } = params;
  const result = new Map<string, MemberGroupingResolution>();

  if (context.mode === "NONE") {
    for (const member of members) {
      result.set(
        member.id,
        resolveMemberGrouping({
          mode: "NONE",
          membershipTypeId: null,
          ageTier: member.ageTier,
          activeRules: context.activeRules,
        }),
      );
    }
    return result;
  }

  const seasonYear = getSeasonYear(params.now ?? new Date());
  const policies = await resolveMembershipTypePoliciesForMembers(prisma, {
    memberIds: members.map((member) => member.id),
    seasonYear,
  });

  for (const member of members) {
    const membershipTypeId = policies.get(member.id)?.membershipType.id ?? null;
    result.set(
      member.id,
      resolveMemberGrouping({
        mode: context.mode,
        membershipTypeId,
        ageTier: member.ageTier,
        activeRules: context.activeRules,
      }),
    );
  }
  return result;
}

/**
 * The managed-group universe under the current mode — groupIds the sync may
 * remove a member from. Empty under NONE. Used by the cancellation path to
 * strip cancelled members from managed groups without reading the retired
 * age-tier columns.
 */
export async function getManagedGroupUniverse(): Promise<string[]> {
  const { mode, activeRules } = await loadXeroGroupingContext();
  return computeManagedUniverse(mode, activeRules);
}
