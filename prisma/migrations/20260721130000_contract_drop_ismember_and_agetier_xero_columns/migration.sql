-- Legacy structure contraction, Release B — #2130 STEP 2: drop the doomed
-- legacy columns on the two cold Xero config tables.
--
-- Background. Two expand/runtime series left key columns behind as a rollback
-- net:
--   * 20260717140000_pricing_rekey_by_membership_type (#1930, E4) re-keyed
--     XeroItemCodeMapping HUT_FEE rows from the member/non-member boolean
--     "isMember" onto "membershipTypeId", fanning every legacy row forward, but
--     RETAINED the isMember column and the old
--     (category, ageTier, seasonType, isMember) unique.
--   * 20260716140000_xero_member_grouping (#1934, E8) migrated
--     AgeTierSetting."xeroContactGroupId"/"xeroContactGroupName" into the
--     XeroContactGroupRule table, but RETAINED both columns.
--
-- Why this is old-code compatible now. Dropping a column is only blue/green
-- safe when the draining previous colour emits NO SQL naming it — and Prisma
-- names EVERY scalar of a model in an unnarrowed find*'s SELECT and in a
-- mutation's implicit RETURNING. Two runtime-prep releases fixed that:
--   * #2133 (STEP 1, shipped in v0.12.2) narrowed every READ of both models to
--     an explicit `select` (xero-mappings.ts getHutFeeItemCodeMap, age-tier.ts
--     getAgeTierSettings and friends).
--   * The #2130 STEP 1.5 release (Release A, immediately preceding this one)
--     narrowed every WRITE — the create/update/upsert paths in the Xero
--     item-code mappings route, the age-tier settings route, the setup wizard,
--     config self-heal and the seeds — so no mutation's RETURNING names these
--     columns either.
-- This migration is therefore legal ONLY once that STEP 1.5 release is itself
-- the deployed/draining colour in production. Do NOT run it before Release A
-- has shipped and soaked.
--
-- Data safety. Step 1 deletes the orphaned legacy isMember-keyed HUT_FEE rows
-- (membershipTypeId IS NULL). Production currently holds 16 of them. They are
-- not resolvable for pricing by the current runtime — both the item-code
-- resolver and the admin editor require membershipTypeId. (Two paths do still
-- touch these rows, but only in aggregate and never column-wise: the readiness
-- probe in src/lib/setup-readiness-db.ts counts HUT_FEE rows with a non-null
-- itemCode without filtering on membershipTypeId, and getNonSubscriptionFeeItemCodes
-- in src/lib/xero-mappings.ts collects itemCode across all rows. Neither names
-- isMember, so neither breaks; the delete only narrows a count and a code set to
-- the rows that actually price something.) They were left behind deliberately by the E4
-- re-key as a rollback net; the equivalent membership-type-keyed rows already
-- exist from that migration's fan-out. They must go before the column drop so
-- the surviving (category, membershipTypeId, seasonType, ageTier) unique is not
-- left guarding rows it cannot distinguish. The DELETE writes no timestamp and
-- uses no session clock (now()/CURRENT_TIMESTAMP), per the non-overridable
-- session-clock DML gate in scripts/validate-blue-green-migrations.sh.
-- The AgeTierSetting Xero-group data was migrated into XeroContactGroupRule by
-- 20260716140000_xero_member_grouping and is dead; production's 4 rows with a
-- non-null xeroContactGroupId are already represented as rules.
--
-- Lock impact: both tables are cold admin-only config tables absent from
-- HOT_TABLE_SQL_REGEX. The DELETE touches ~16 rows. DROP CONSTRAINT and DROP
-- COLUMN are metadata-only catalog changes (no table rewrite, no row scan) with
-- a brief ACCESS EXCLUSIVE lock each. Run in the normal deploy window and let
-- the deploy guard stop on lock timeout. No provider call; no Xero contact,
-- item or invoice is touched.

-- 1. Orphaned legacy isMember-keyed HUT_FEE mappings (no membership-type key).
--    Not resolvable for pricing by the current runtime; superseded by the E4
--    fan-out rows.
DELETE FROM "XeroItemCodeMapping"
WHERE "category" = 'HUT_FEE' AND "membershipTypeId" IS NULL;

-- 2. The old member/non-member-keyed unique that guarded those rows. Prisma
--    created it as a bare UNIQUE INDEX (20260413160000_add_xero_item_code_mapping),
--    not a table constraint, so it is dropped with DROP INDEX.
DROP INDEX "XeroItemCodeMapping_category_ageTier_seasonType_isMember_key";

-- 3. The legacy member/non-member key column itself (#1930, E4 re-keyed it).
ALTER TABLE "XeroItemCodeMapping" DROP COLUMN "isMember";

-- 4. The legacy single-group age-tier Xero columns (#1934, E8 migrated their
--    data into XeroContactGroupRule).
ALTER TABLE "AgeTierSetting"
  DROP COLUMN "xeroContactGroupId",
  DROP COLUMN "xeroContactGroupName";
