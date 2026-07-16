-- E8 (#1934): Xero member grouping — mode setting + converge on XeroContactGroupRule.
--
-- This migration is DB-only and idempotent. It performs ZERO Xero calls.
--
-- 1. New enum XeroMemberGroupingMode and singleton XeroGroupingSettings.
-- 2. Safety pass over pre-existing XeroContactGroupRule rows (first run only):
--    a. Deactivate every rule NOT created by this migration's backfill. Rows
--       written by the retired membership-types editor were never read by the
--       live sync; left active they would join the managed universe at deploy
--       and (being type-keyed, hence more specific) outrank the tier-only
--       backfill rules — live re-grouping before the runbook dry-run. Admins
--       can deliberately re-enable them later via the new grouping UI.
--    b. Defensive shape-dedupe (keep the earliest row per
--       (membershipTypeId, ageTier, mode, groupId), NULLs comparing equal) so
--       the unique-index creation below cannot fail on legacy duplicates.
-- 3. A raw-SQL partial unique index deduping rule shapes. Prisma cannot express
--    NULLS NOT DISTINCT, so it is recorded in prisma/partial-unique-indexes.tsv
--    and enforced by scripts/check-partial-indexes.sh. The WHERE predicate
--    ("groupId" IS NOT NULL — always true) keeps the index invisible to
--    prisma migrate diff / db:check-drift (same trick as the other partial
--    unique indexes), while NULLS NOT DISTINCT makes tier-only rows (NULL
--    membershipTypeId) dedupe correctly.
-- 4. Backfill the age-tier Xero group config (Tokoroa's live setup) onto
--    XeroContactGroupRule as tier-only rules — each AgeTierSetting primary group
--    becomes a MANAGED tier-only rule; each accepted group becomes an ACCEPTED
--    tier-only rule. Ids are deterministic so re-running the migration is a
--    no-op; ON CONFLICT DO NOTHING guards against the shape-unique index.
-- 5. Seed the grouping mode: MEMBERSHIP_TYPE_AND_AGE when ANY age-tier group
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

-- 2b. Deactivate dormant pre-existing rules (BEFORE the backfill) --------------
-- Rows written by the old membership-types editor carried isActive = true but
-- were never read by the live sync. From this migration on, isActive rules ARE
-- the managed universe, so any pre-existing rule must go dormant until an admin
-- deliberately re-enables it via the new grouping UI. Guarded on the settings
-- singleton not existing yet (created in section 4 below) so a re-run after
-- go-live never deactivates rules admins created through the new UI.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "XeroGroupingSettings" WHERE "id" = 'default') THEN
    UPDATE "XeroContactGroupRule"
    -- Explicit UTC (not session-clock CURRENT_TIMESTAMP) per the #1627/#1656
    -- session-clock DML gate: naive timestamp columns must not record the
    -- database session's local wall-clock.
    SET "isActive" = false, "updatedAt" = timezone('UTC', statement_timestamp())
    WHERE "isActive" = true
      AND "id" NOT LIKE 'xcgr-managed-%'
      AND "id" NOT LIKE 'xcgr-accepted-%';
  END IF;
END $$;

-- 2c. Defensive shape-dedupe (BEFORE the unique index) -------------------------
-- Legacy writers enforced no shape uniqueness, so duplicates may exist and
-- would make the CREATE UNIQUE INDEX below fail. Keep the earliest row per
-- (membershipTypeId, ageTier, mode, groupId) — NULLs compare equal via
-- IS NOT DISTINCT FROM, matching the index's NULLS NOT DISTINCT semantics —
-- and delete the rest. Idempotent: an already-deduped table deletes nothing.
DELETE FROM "XeroContactGroupRule" AS dup
USING "XeroContactGroupRule" AS keeper
WHERE dup."membershipTypeId" IS NOT DISTINCT FROM keeper."membershipTypeId"
  AND dup."ageTier" IS NOT DISTINCT FROM keeper."ageTier"
  AND dup."mode" = keeper."mode"
  AND dup."groupId" = keeper."groupId"
  AND (keeper."createdAt", keeper."id") < (dup."createdAt", dup."id");

-- 2d. Rule-shape partial unique index (dedupe) -------------------------------
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
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
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
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
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
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
ON CONFLICT ("id") DO NOTHING;
