-- Legacy structure contraction, phase E13 (#1939) — SAFE SUBSET.
--
-- The pricing/fee/grouping expand-migrate-contract series (E4 #1930, E5 #1931,
-- E8 #1934) deliberately left several legacy structures in place but unused as a
-- rollback net. This contract migration removes the two that are provably safe to
-- drop RIGHT NOW under the blue/green rule (docs/BLUE_GREEN_MIGRATION_POLICY.md):
-- a migration runs while the PREVIOUS colour may still serve traffic, so a drop is
-- old-code-compatible only when the currently-deployed runtime emits NO SQL that
-- names the dropped structure.
--
-- IN THIS MIGRATION (old-colour-safe — previous runtime issues no SQL against them):
--   1. DROP TABLE "EntranceFee" — the category-keyed one-off fee table. E5
--      (#1931) re-keyed it to JoiningFee (membership type x optional age tier) and
--      copied every window forward; no deployed code path reads prisma.entranceFee
--      (grep-proven zero readers, current HEAD). The `EntranceFeeCategory` enum is
--      intentionally KEPT — it still keys XeroItemCodeMapping.entranceFeeCategory
--      for the live JOINING_FEE item-code mappings, so it is NOT dropped here.
--   2. DROP TABLE "AgeTierXeroAcceptedContactGroup" — the age-tier Xero
--      accepted-group aliases table. E8 (#1934) converged its data into
--      XeroContactGroupRule; no deployed code queries the table or `include`s the
--      AgeTierSetting.xeroAcceptedContactGroups relation, so no old-colour SELECT
--      or JOIN references it.
--   3. DELETE the orphaned `entranceFeeAmountCents` XeroAccountMapping row — E5
--      removed its only reader (authoritative-fees.ts flat fallback); the row is
--      inert data. Row delete only; the XeroAccountMapping.key column is retained.
--
-- DELIBERATELY NOT IN THIS MIGRATION (deferred; see the #1939 PR body):
--   * XeroItemCodeMapping.isMember (+ its old @@unique) and
--     AgeTierSetting.xeroContactGroupId/xeroContactGroupName are still SELECTed by
--     the currently-deployed runtime via no-`select` findMany calls
--     (xero-mappings.ts getHutFeeItemCodeMap; age-tier.ts getAgeTierSettings), so
--     dropping the COLUMNS now would break the draining old colour. They need a
--     runtime-prep release that stops selecting them first, then a later contract
--     drop.
--   * SeasonRate is still read by the live public {{hut-fees}} embed
--     (loadPublicHutFees) — it is NOT unused and needs an owner decision on the
--     public-embed data source before it can be dropped.
--
-- No table rewrite, no hot table, no session-clock DML. DROP TABLE takes a brief
-- ACCESS EXCLUSIVE lock on each cold config table only.

-- 1. Retired category-keyed one-off fee table (E5 #1931 superseded by JoiningFee).
DROP TABLE "EntranceFee";

-- 2. Retired age-tier Xero accepted-group aliases (E8 #1934 superseded by
--    XeroContactGroupRule). Child of AgeTierSetting; nothing references it.
DROP TABLE "AgeTierXeroAcceptedContactGroup";

-- 3. Orphaned flat entrance-fee amount mapping row (E5 removed its only reader).
DELETE FROM "XeroAccountMapping" WHERE "key" = 'entranceFeeAmountCents';
