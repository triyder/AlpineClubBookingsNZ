import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveMemberGrouping,
  planMemberGroupingSync,
  type XeroGroupingRule,
} from "@/lib/xero-member-grouping";

// ---------------------------------------------------------------------------
// Rule fixtures
// ---------------------------------------------------------------------------

function managed(
  overrides: Partial<XeroGroupingRule> & Pick<XeroGroupingRule, "groupId">,
): XeroGroupingRule {
  return {
    membershipTypeId: null,
    ageTier: null,
    kind: "MANAGED",
    groupName: overrides.groupId,
    sortOrder: 0,
    ...overrides,
  };
}

function accepted(
  overrides: Partial<XeroGroupingRule> & Pick<XeroGroupingRule, "groupId">,
): XeroGroupingRule {
  return {
    membershipTypeId: null,
    ageTier: null,
    kind: "ACCEPTED",
    groupName: overrides.groupId,
    sortOrder: 0,
    ...overrides,
  };
}

describe("resolveMemberGrouping", () => {
  describe("NONE mode", () => {
    it("is a total no-op regardless of rules", () => {
      const res = resolveMemberGrouping({
        mode: "NONE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: [managed({ groupId: "g-adult", ageTier: "ADULT" })],
      });
      expect(res.managedGroup).toBeNull();
      expect(res.acceptedGroupIds).toEqual([]);
      expect(res.managedUniverse).toEqual([]);
      expect(res.skippedReason).toBe("grouping_mode_none");
    });
  });

  describe("MEMBERSHIP_TYPE mode", () => {
    const rules: XeroGroupingRule[] = [
      managed({ groupId: "g-life", membershipTypeId: "life" }),
      accepted({ groupId: "g-life-legacy", membershipTypeId: "life" }),
      // tier-bearing rules are inert in this mode
      managed({ groupId: "g-adult", ageTier: "ADULT" }),
      managed({ groupId: "g-assoc", membershipTypeId: "assoc" }),
    ];

    it("matches type-only rules and ignores tier-bearing rules", () => {
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE",
        membershipTypeId: "life",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.managedGroup).toEqual({ id: "g-life", name: "g-life" });
      expect(res.acceptedGroupIds.sort()).toEqual(["g-life", "g-life-legacy"]);
      expect(res.skippedReason).toBeNull();
    });

    it("excludes tier-bearing rule groups from the managed universe", () => {
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE",
        membershipTypeId: "life",
        ageTier: "ADULT",
        activeRules: rules,
      });
      // g-adult (tier-bearing) must NOT be a removal candidate in type mode
      expect(res.managedUniverse).not.toContain("g-adult");
      expect(res.managedUniverse.sort()).toEqual([
        "g-assoc",
        "g-life",
        "g-life-legacy",
      ]);
    });

    it("skips when the member's type matches no rule", () => {
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE",
        membershipTypeId: "school",
        ageTier: "YOUTH",
        activeRules: rules,
      });
      expect(res.managedGroup).toBeNull();
      expect(res.skippedReason).toBe("no_matching_rule");
    });
  });

  describe("MEMBERSHIP_TYPE_AND_AGE mode", () => {
    it("prefers most-specific MANAGED match: type+tier > type-only > tier-only", () => {
      const rules: XeroGroupingRule[] = [
        managed({ groupId: "g-tier", ageTier: "ADULT" }),
        managed({ groupId: "g-type", membershipTypeId: "full" }),
        managed({ groupId: "g-both", membershipTypeId: "full", ageTier: "ADULT" }),
      ];
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.managedGroup?.id).toBe("g-both");
    });

    it("falls back to type-only when no type+tier rule exists", () => {
      const rules: XeroGroupingRule[] = [
        managed({ groupId: "g-tier", ageTier: "ADULT" }),
        managed({ groupId: "g-type", membershipTypeId: "full" }),
      ];
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.managedGroup?.id).toBe("g-type");
    });

    it("uses tier-only rule when that is the only match (Tokoroa backfill shape)", () => {
      const rules: XeroGroupingRule[] = [
        managed({ groupId: "g-adult", ageTier: "ADULT" }),
        accepted({ groupId: "g-adult-legacy", ageTier: "ADULT" }),
      ];
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.managedGroup).toEqual({ id: "g-adult", name: "g-adult" });
      expect(res.acceptedGroupIds.sort()).toEqual(["g-adult", "g-adult-legacy"]);
      // universe spans all active groups (tier-only rules count)
      expect(res.managedUniverse.sort()).toEqual(["g-adult", "g-adult-legacy"]);
    });

    it("accepted set is the union of matching accepted rules plus the managed group", () => {
      const rules: XeroGroupingRule[] = [
        managed({ groupId: "g-adult", ageTier: "ADULT" }),
        accepted({ groupId: "g-x", ageTier: "ADULT" }),
        accepted({ groupId: "g-y", membershipTypeId: "full" }),
        accepted({ groupId: "g-other-tier", ageTier: "YOUTH" }),
      ];
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.acceptedGroupIds.sort()).toEqual(["g-adult", "g-x", "g-y"]);
    });

    it("skips (no removals) when the member matches no rule", () => {
      const rules: XeroGroupingRule[] = [
        managed({ groupId: "g-youth", ageTier: "YOUTH" }),
      ];
      const res = resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier: "ADULT",
        activeRules: rules,
      });
      expect(res.managedGroup).toBeNull();
      expect(res.skippedReason).toBe("no_matching_rule");
    });
  });
});

describe("planMemberGroupingSync", () => {
  const rules: XeroGroupingRule[] = [
    managed({ groupId: "g-adult", ageTier: "ADULT" }),
    accepted({ groupId: "g-adult-legacy", ageTier: "ADULT" }),
    managed({ groupId: "g-youth", ageTier: "YOUTH" }),
  ];

  function resolveAdult() {
    return resolveMemberGrouping({
      mode: "MEMBERSHIP_TYPE_AND_AGE",
      membershipTypeId: "full",
      ageTier: "ADULT",
      activeRules: rules,
    });
  }

  it("adds the managed group when the member is in none of its accepted groups", () => {
    const plan = planMemberGroupingSync({
      resolution: resolveAdult(),
      currentGroupIds: [],
    });
    expect(plan.groupToAdd?.id).toBe("g-adult");
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(false);
  });

  it("suppresses the add when the member already sits in an ACCEPTED group", () => {
    const plan = planMemberGroupingSync({
      resolution: resolveAdult(),
      currentGroupIds: ["g-adult-legacy"],
    });
    expect(plan.groupToAdd).toBeNull();
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });

  it("is a no-op when the member already sits in the managed group", () => {
    const plan = planMemberGroupingSync({
      resolution: resolveAdult(),
      currentGroupIds: ["g-adult"],
    });
    expect(plan.groupToAdd).toBeNull();
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });

  it("removes managed-universe groups the member should not be in, and adds the managed one", () => {
    const plan = planMemberGroupingSync({
      resolution: resolveAdult(),
      currentGroupIds: ["g-youth"],
    });
    expect(plan.groupToAdd?.id).toBe("g-adult");
    expect(plan.groupIdsToRemove).toEqual(["g-youth"]);
  });

  it("never removes unlisted (non-managed-universe) groups", () => {
    const plan = planMemberGroupingSync({
      resolution: resolveAdult(),
      currentGroupIds: ["g-adult", "some-unlisted-group"],
    });
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });

  it("performs zero writes in NONE mode even when the member sits in a former managed group", () => {
    const resolution = resolveMemberGrouping({
      mode: "NONE",
      membershipTypeId: "full",
      ageTier: "ADULT",
      activeRules: rules,
    });
    const plan = planMemberGroupingSync({
      resolution,
      currentGroupIds: ["g-youth", "g-adult"],
    });
    expect(plan.groupToAdd).toBeNull();
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.skippedReason).toBe("grouping_mode_none");
    expect(plan.isNoop).toBe(true);
  });

  it("performs no removals when the member matches no rule but sits in a managed group", () => {
    const resolution = resolveMemberGrouping({
      mode: "MEMBERSHIP_TYPE_AND_AGE",
      membershipTypeId: "full",
      ageTier: "NOT_APPLICABLE",
      activeRules: rules,
    });
    const plan = planMemberGroupingSync({
      resolution,
      currentGroupIds: ["g-adult"],
    });
    expect(plan.skippedReason).toBe("no_matching_rule");
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });
});

describe("Tokoroa semantic preservation (migrated tier-only rules, zero diff)", () => {
  // Mirrors a realistic age-tier config after the backfill: each tier has a
  // MANAGED primary group plus (for adults) a tolerated ACCEPTED group. Under
  // MEMBERSHIP_TYPE_AND_AGE with tier-only rules, correctly-grouped members must
  // produce ZERO Xero writes — the migration dry-run's "≈ zero diff" proof.
  const rules: XeroGroupingRule[] = [
    managed({ groupId: "adult_group", ageTier: "ADULT" }),
    accepted({ groupId: "adult_committee", ageTier: "ADULT" }),
    managed({ groupId: "youth_group", ageTier: "YOUTH" }),
    managed({ groupId: "child_group", ageTier: "CHILD" }),
  ];

  function planFor(ageTier: "ADULT" | "YOUTH" | "CHILD", currentGroupIds: string[]) {
    return planMemberGroupingSync({
      resolution: resolveMemberGrouping({
        mode: "MEMBERSHIP_TYPE_AND_AGE",
        membershipTypeId: "full",
        ageTier,
        activeRules: rules,
      }),
      currentGroupIds,
    });
  }

  it("adult already in the managed group: zero diff", () => {
    expect(planFor("ADULT", ["adult_group"]).isNoop).toBe(true);
  });

  it("adult parked in an accepted group: no spurious add, zero diff", () => {
    const plan = planFor("ADULT", ["adult_committee"]);
    expect(plan.groupToAdd).toBeNull();
    expect(plan.groupIdsToRemove).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });

  it("youth already in the youth group: zero diff", () => {
    expect(planFor("YOUTH", ["youth_group"]).isNoop).toBe(true);
  });

  it("only a genuinely mis-grouped member produces a diff", () => {
    const plan = planFor("ADULT", ["youth_group"]);
    expect(plan.groupToAdd?.id).toBe("adult_group");
    expect(plan.groupIdsToRemove).toEqual(["youth_group"]);
  });
});
