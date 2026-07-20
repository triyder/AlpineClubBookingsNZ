import { describe, expect, it } from "vitest";
import {
  checkDisposableLocalDatabaseUrl,
  evaluateAuditSnapshots,
  parseKeyCountRows,
  type AuditSnapshot,
} from "../audit-access-role-membership-cleanup";

function snapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    memberRoles: {},
    financeAccessLevels: {},
    accessRoles: {},
    membershipTypes: {},
    seasonalAssignments: {},
    xeroRulesByMode: {},
    xeroRulesByAgeTier: {},
    familyGroupRoles: {},
    metrics: {},
    ...overrides,
  };
}

describe("checkDisposableLocalDatabaseUrl", () => {
  it("accepts a local scratch database", () => {
    expect(
      checkDisposableLocalDatabaseUrl(
        "postgresql://postgres:postgres@127.0.0.1:55435/access_role_audit",
      ),
    ).toEqual({
      ok: true,
      databaseName: "access_role_audit",
      host: "127.0.0.1",
    });
  });

  it("rejects non-local database hosts", () => {
    const result = checkDisposableLocalDatabaseUrl(
      "postgresql://user:pass@db.example.org/access_role_audit",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("non-local");
  });

  it("rejects local database names that do not look disposable", () => {
    const result = checkDisposableLocalDatabaseUrl(
      "postgresql://postgres:postgres@localhost/alpineclub",
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("Database name");
  });
});

describe("parseKeyCountRows", () => {
  it("parses psql tab-separated counts", () => {
    expect(parseKeyCountRows("ADMIN\t1\nUSER\t7\n")).toEqual({
      ADMIN: 1,
      USER: 7,
    });
  });
});

describe("evaluateAuditSnapshots", () => {
  it("checks the expected access-role and membership cleanup counts", () => {
    const before = snapshot({
      memberRoles: {
        MEMBER: 5,
        ASSOCIATE: 1,
        LIFE: 1,
        ADMIN: 1,
        LODGE: 1,
      },
      financeAccessLevels: {
        NONE: 10,
        VIEWER: 1,
        MANAGER: 1,
      },
      seasonalAssignments: {
        ASSOCIATE: 1,
        RESERVE: 1,
      },
      familyGroupRoles: {
        ADMIN: 1,
        MEMBER: 1,
      },
      metrics: {
        acceptedAgeTierGroups: 2,
        familyGroupMemberRows: 2,
        // managedAgeTierSettings removed with its check (#2130) — it counted
        // AgeTierSetting."xeroContactGroupId", dropped by the follow-on
        // contract migration.
        nonMemberFullAssignments: 1,
        schoolFullAssignments: 2,
        schoolLoginMembers: 1,
      },
    });
    const after = snapshot({
      memberRoles: {
        USER: 7,
        ADMIN: 1,
        LODGE: 1,
      },
      accessRoles: {
        USER: 7,
        ADMIN: 1,
        LODGE: 1,
        FINANCE_USER: 1,
        FINANCE_ADMIN: 1,
        ORG: 1,
      },
      membershipTypes: {
        FULL: 1,
        ASSOCIATE: 1,
        LIFE: 1,
        SCHOOL: 1,
        NON_MEMBER: 1,
        FAMILY: 1,
      },
      seasonalAssignments: {
        ASSOCIATE: 2,
        SCHOOL: 2,
        NON_MEMBER: 1,
      },
      xeroRulesByMode: {
        // MANAGED intentionally absent: #2130 removed the "Managed Xero
        // age-tier rules backfilled" check, so no check consumes it any more.
        ACCEPTED: 2,
      },
      familyGroupRoles: {
        ADMIN: 1,
        MEMBER: 1,
      },
      metrics: {
        familyGroupMemberRows: 2,
        legacyNonMemberSourceDetailRows: 3,
        membershipTypeAgeTierRows: 17,
        nonMemberNonMemberAssignments: 1,
        reserveSourceDetailRows: 1,
        schoolSchoolAssignments: 2,
      },
    });

    const evaluation = evaluateAuditSnapshots(before, after);

    // Pin the count as well as the pass/fail: `every(...)` is vacuously true
    // over a shrinking list, so without this a future deletion of a
    // conservation check (as #2130 did to "Managed Xero age-tier rules
    // backfilled") would silently keep this test green.
    expect(evaluation.checks).toHaveLength(24);
    expect(evaluation.checks.every((check) => check.ok)).toBe(true);
    expect(evaluation.warnings).toEqual([
      expect.stringContaining("Both RESERVE and ASSOCIATE"),
    ]);
  });
});
