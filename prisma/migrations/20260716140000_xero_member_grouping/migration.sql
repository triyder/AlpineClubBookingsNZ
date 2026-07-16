-- E8 (#1934): Xero member grouping — mode setting + converge on XeroContactGroupRule.
--
-- This migration is DB-only and idempotent. It performs ZERO Xero calls.
--
-- 1. New enum XeroMemberGroupingMode and singleton XeroGroupingSettings.
-- 2. A raw-SQL partial unique index deduping rule shapes. Prisma cannot express
--    NULLS NOT DISTINCT, so it is recorded in prisma/partial-unique-indexes.tsv
--    and enforced by scripts/check-partial-indexes.sh. The WHERE predicate
--    ("groupId" IS NOT NULL — always true) keeps the index invisible to
--    prisma migrate diff / db:check-drift (same trick as the other partial
--    unique indexes), while NULLS NOT DISTINCT makes tier-only rows (NULL
--    membershipTypeId) dedupe correctly.
-- 3. Backfill the age-tier Xero group config (Tokoroa's live setup) onto
--    XeroContactGroupRule as tier-only rules — each AgeTierSetting primary group
--    becomes a MANAGED tier-only rule; each accepted group becomes an ACCEPTED
--    tier-only rule. Ids are deterministic so re-running the migration is a
--    no-op; ON CONFLICT DO NOTHING guards against the shape-unique index.
-- 4. Seed the grouping mode: MEMBERSHIP_TYPE_AND_AGE when ANY age-tier group
--    config existed (tier-only rules resolve identically to the retired
--    age-only sync, so Tokoroa keeps its behaviour with zero re-grouping),
--    otherwise NONE.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE "XeroMemberGroupingMode" AS ENUM ('NONE', 'MEMBERSHIP_TYPE', 'MEMBERSHIP_TYPE_AND_AGE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2a. Singleton settings table -----------------------------------------------
CREATE TABLE IF NOT EXISTS "XeroGroupingSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "mode" "XeroMemberGroupingMode" NOT NULL DEFAULT 'NONE',
  "updatedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "XeroGroupingSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "XeroGroupingSettings_updatedByMemberId_idx"
  ON "XeroGroupingSettings"("updatedByMemberId");

-- 2b. Rule-shape partial unique index (dedupe) -------------------------------
-- NULLS NOT DISTINCT (PostgreSQL 15+) so two tier-only rows with NULL
-- membershipTypeId collide on (ageTier, mode, groupId). Recorded in
-- prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"
  ON "XeroContactGroupRule" ("membershipTypeId", "ageTier", "mode", "groupId")
  NULLS NOT DISTINCT
  WHERE "groupId" IS NOT NULL;

-- 3a. Backfill MANAGED tier-only rules from AgeTierSetting primary groups -----
INSERT INTO "XeroContactGroupRule"
  ("id", "membershipTypeId", "ageTier", "mode", "groupId", "groupName", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT
  'xcgr-managed-' || md5(s."tier"::text || ':' || s."xeroContactGroupId"),
  NULL,
  s."tier",
  'MANAGED'::"XeroContactGroupRuleMode",
  s."xeroContactGroupId",
  s."xeroContactGroupName",
  true,
  s."sortOrder",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "AgeTierSetting" s
WHERE s."xeroContactGroupId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3b. Backfill ACCEPTED tier-only rules from accepted-group rows --------------
INSERT INTO "XeroContactGroupRule"
  ("id", "membershipTypeId", "ageTier", "mode", "groupId", "groupName", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT
  'xcgr-accepted-' || md5(s."tier"::text || ':' || a."groupId"),
  NULL,
  s."tier",
  'ACCEPTED'::"XeroContactGroupRuleMode",
  a."groupId",
  a."groupName",
  true,
  s."sortOrder",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "AgeTierXeroAcceptedContactGroup" a
JOIN "AgeTierSetting" s ON s."id" = a."ageTierSettingId"
ON CONFLICT DO NOTHING;

-- 4. Seed the singleton grouping mode ----------------------------------------
-- MEMBERSHIP_TYPE_AND_AGE when any age-tier group config (primary OR accepted)
-- existed, otherwise NONE. Idempotent: on conflict the existing row wins so a
-- re-run never clobbers an admin-chosen mode.
INSERT INTO "XeroGroupingSettings" ("id", "mode", "createdAt", "updatedAt")
SELECT
  'default',
  CASE
    WHEN EXISTS (SELECT 1 FROM "AgeTierSetting" WHERE "xeroContactGroupId" IS NOT NULL)
      OR EXISTS (SELECT 1 FROM "AgeTierXeroAcceptedContactGroup")
    THEN 'MEMBERSHIP_TYPE_AND_AGE'::"XeroMemberGroupingMode"
    ELSE 'NONE'::"XeroMemberGroupingMode"
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
ON CONFLICT ("id") DO NOTHING;
