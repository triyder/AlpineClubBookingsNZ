import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260716140000_xero_member_grouping/migration.sql",
  ),
  "utf8",
);

const partialIndexManifest = readFileSync(
  join(process.cwd(), "prisma/partial-unique-indexes.tsv"),
  "utf8",
);

describe("xero member grouping migration (#1934)", () => {
  it("creates the grouping-mode enum and singleton settings table", () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "XeroMemberGroupingMode" AS ENUM ('NONE', 'MEMBERSHIP_TYPE', 'MEMBERSHIP_TYPE_AND_AGE')`,
    );
    expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "XeroGroupingSettings"`);
  });

  it("creates the rule-shape partial unique index with NULLS NOT DISTINCT", () => {
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"`);
    expect(migrationSql).toContain(`NULLS NOT DISTINCT`);
    expect(migrationSql).toContain(`WHERE "groupId" IS NOT NULL`);
  });

  it("records the partial index in the CI-enforced manifest", () => {
    expect(partialIndexManifest).toContain("XeroContactGroupRule_shape_unique");
    expect(partialIndexManifest).toContain("NULLS NOT DISTINCT");
  });

  it("backfills tier-only MANAGED rules from AgeTierSetting primary groups", () => {
    expect(migrationSql).toMatch(
      /INSERT INTO "XeroContactGroupRule"[\s\S]*'MANAGED'::"XeroContactGroupRuleMode"[\s\S]*FROM "AgeTierSetting" s[\s\S]*WHERE s\."xeroContactGroupId" IS NOT NULL/,
    );
  });

  it("backfills tier-only ACCEPTED rules from accepted-group rows", () => {
    expect(migrationSql).toMatch(
      /'ACCEPTED'::"XeroContactGroupRuleMode"[\s\S]*FROM "AgeTierXeroAcceptedContactGroup" a[\s\S]*JOIN "AgeTierSetting" s/,
    );
  });

  it("is idempotent: deterministic ids + ON CONFLICT DO NOTHING", () => {
    expect(migrationSql).toContain("ON CONFLICT DO NOTHING");
    expect(migrationSql).toContain("'xcgr-managed-' || md5(");
    expect(migrationSql).toContain("'xcgr-accepted-' || md5(");
  });

  it("seeds MEMBERSHIP_TYPE_AND_AGE only when age-tier group config existed, else NONE", () => {
    expect(migrationSql).toMatch(
      /CASE[\s\S]*EXISTS \(SELECT 1 FROM "AgeTierSetting" WHERE "xeroContactGroupId" IS NOT NULL\)[\s\S]*OR EXISTS \(SELECT 1 FROM "AgeTierXeroAcceptedContactGroup"\)[\s\S]*THEN 'MEMBERSHIP_TYPE_AND_AGE'[\s\S]*ELSE 'NONE'/,
    );
    // Never clobber an admin-chosen mode on re-run.
    expect(migrationSql).toContain(`ON CONFLICT ("id") DO NOTHING`);
  });

  it("performs no Xero calls (DB-only migration)", () => {
    expect(migrationSql.toLowerCase()).not.toContain("http");
  });
});
