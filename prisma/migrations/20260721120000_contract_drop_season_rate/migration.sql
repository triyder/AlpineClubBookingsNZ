-- Legacy structure contraction, Release B — #2129 step 2: drop the frozen
-- member/non-member boolean-keyed hut-rate table "SeasonRate".
--
-- Background. The E4 pricing re-key (#1930,
-- 20260717140000_pricing_rekey_by_membership_type) moved authoritative nightly
-- pricing onto "MembershipTypeSeasonRate" (season x membership type x optional
-- age tier) and fanned every existing SeasonRate row forward, but deliberately
-- RETAINED SeasonRate as a rollback net. E13 (#1939,
-- 20260720120000_contract_drop_entrance_fee_and_agetier_xero_group) could not
-- drop it because the live public {{hut-fees}} page-content embed
-- (loadPublicHutFees) still read its member/non-member split.
--
-- Why this is old-code compatible now. #2129 step 1 (Release A) re-sourced that
-- embed onto MembershipTypeSeasonRate and removed the admin season routes'
-- unused `rates` include, eliminating the last APPLICATION-RUNTIME reader. The
-- only survivors were seed-time reader/writers outside src/ — the
-- `include: { rates: true }` and `rates: { create: ... }` in
-- e2e/setup/seed-second-lodge.ts and `createMissingSeasonRates` in
-- prisma/seed.ts — and the SAME pull request as this migration removes all
-- three. Seeders are not the deployed web runtime, so no draining old colour
-- issues SQL naming "SeasonRate". This migration is therefore legal ONLY once
-- the #2129 step 1 release is the deployed/draining colour in production; do
-- not run it before that release has shipped and soaked.
--
-- No data is lost that any code can still resolve: every SeasonRate row was
-- copied forward by the E4 fan-out backfill (isMember=true -> every
-- MEMBER_RATE membership type, isMember=false -> the built-in NON_MEMBER type)
-- and pricing has resolved from MembershipTypeSeasonRate since. Step 0 below
-- PROVES that on this database rather than assuming it.
--
-- Lock impact: DROP TABLE takes a brief ACCESS EXCLUSIVE lock on one cold
-- config table (SeasonRate is not in HOT_TABLE_SQL_REGEX). Its FK to Season is
-- ON DELETE CASCADE and no other table references it, so no dependent object
-- survives the drop. No table rewrite, no DML, no session clock, no provider
-- call. The step 0 guard adds one read-only anti-join count over the same small
-- cold table (tens of rows), taking no lock beyond ACCESS SHARE.

-- 0. PRE-DROP COVERAGE GUARD. Abort instead of destroying data.
--
--    What this protects against. The E4 fan-out that copied SeasonRate forward
--    (20260717140000_pricing_rekey_by_membership_type) was CONDITIONAL, not
--    unconditional: isMember=true rows only produced MembershipTypeSeasonRate
--    output where a membership type with bookingBehavior MEMBER_RATE existed,
--    and isMember=false rows only where a type with key='NON_MEMBER' existed.
--    Both halves are plain SELECT-driven INSERTs, so on an install whose
--    membership types did not match either shape they inserted ZERO rows and
--    succeeded silently. On such a fork SeasonRate is still the ONLY copy of
--    that pricing, and a bare DROP TABLE here would destroy it — discovered at
--    the first booking quote, recoverable only from backup. This migration
--    ships to public forks, not just to the reference install, so it must not
--    assume the fan-out landed.
--
--    Every SeasonRate row must therefore have at least one
--    MembershipTypeSeasonRate counterpart for the same (seasonId, ageTier)
--    before the table may go. Inactive and past seasons are deliberately
--    included: they are historical pricing and are equally unrecoverable.
--
--    IF THIS RAISES, INVESTIGATE — DO NOT FORCE. The exception aborts the
--    whole migration inside its transaction, so nothing is dropped and the
--    deploy stops before cutover with the old colour still serving. The fix is
--    to RECONCILE the missing rates — create the MembershipTypeSeasonRate rows
--    for the reported seasons/tiers (Admin -> Seasons & Rates, or by hand from
--    the SeasonRate rows themselves) and re-run the deploy. Deleting the
--    orphaned SeasonRate rows, or deleting this guard, converts a safe abort
--    back into the silent data loss it exists to prevent.
--
--    The same check is published as a read-only pre-flight query in
--    docs/UPGRADING.md -> "Before deploying Release B", so an operator can
--    clear it before starting rather than discovering it mid-deploy.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans
  FROM "SeasonRate" sr
  WHERE NOT EXISTS (
    SELECT 1
    FROM "MembershipTypeSeasonRate" m
    WHERE m."seasonId" = sr."seasonId"
      AND m."ageTier" IS NOT DISTINCT FROM sr."ageTier"
  );
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop SeasonRate: % row(s) have no MembershipTypeSeasonRate counterpart', orphans;
  END IF;
END
$$;

-- 1. Retired member/non-member boolean-keyed hut-rate table (E4 #1930
--    superseded it with MembershipTypeSeasonRate; #2129 removed its readers).
DROP TABLE "SeasonRate";
