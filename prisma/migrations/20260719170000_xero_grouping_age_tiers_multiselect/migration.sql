-- #2093: Xero member-grouping rules gain multi-select age tiers.
--
-- Converts XeroContactGroupRule.ageTier (scalar AgeTier?) into ageTiers
-- (AgeTier[]). This migration is DB-only and idempotent, performs ZERO Xero
-- calls, and touches only the small admin-only XeroContactGroupRule config
-- table (not in HOT_TABLE_SQL_REGEX).
--
-- Mapping (D-B2): ageTier = X -> [X], NULL -> [] (empty array = "all tiers",
-- preserving today's null "Any age" semantics). Arrays are stored
-- canonical-sorted; a single element is trivially sorted and an empty array is
-- empty, so the backfill is already canonical.
--
-- The rule-shape partial unique index is reworked from the scalar column to the
-- array column. Postgres btree array equality (array_ops) is ORDER-SENSITIVE: it
-- enforces equality over the array AS STORED, so a raw [ADULT, YOUTH] and a raw
-- [YOUTH, ADULT] are DISTINCT at the DB level — the index does NOT canonicalize.
-- Reordered tier sets collide as one shape only because the app always writes
-- canonical-sorted arrays (normalizeRule -> canonicalizeAgeTiers). A direct-SQL
-- write of a non-canonical array would bypass that; the app-side dedupe
-- (isDuplicateRuleShape) plus the defensive shape-dedupe in step 6 below are the
-- guards. NULLS NOT DISTINCT still makes two type-wildcard (NULL membershipTypeId)
-- rules with the same stored tier set collide. The predicate ("groupId" IS NOT
-- NULL — always true) keeps the index invisible to prisma migrate diff /
-- db:check-drift, as with the other partial unique indexes.

-- 1. Add the new array column ------------------------------------------------
-- The DEFAULT is transitional only: it lets the NOT NULL column land on a table
-- that already has rows (every existing row becomes [] = "all tiers" before the
-- backfill refines non-NULL scalars). Prisma's final column state for a list
-- field carries NO database default — step 8 drops it, or db:check-drift flags
-- `default changed from Some([]) to None`.
ALTER TABLE "XeroContactGroupRule"
  ADD COLUMN IF NOT EXISTS "ageTiers" "AgeTier"[] NOT NULL DEFAULT ARRAY[]::"AgeTier"[];

-- 2. Backfill from the scalar column (D-B2): X -> [X], NULL -> [] -------------
-- Guarded on the scalar column still existing so a re-run after the DROP below
-- is a no-op. Empty array for NULL is already the column default, so only
-- non-NULL rows need the single-element array.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'XeroContactGroupRule'
      AND column_name = 'ageTier'
  ) THEN
    EXECUTE '
      UPDATE "XeroContactGroupRule"
      SET "ageTiers" = ARRAY["ageTier"]::"AgeTier"[]
      WHERE "ageTier" IS NOT NULL
    ';
  END IF;
END $$;

-- 3. Drop the old rule-shape partial unique index (keyed on the scalar) ------
DROP INDEX IF EXISTS "XeroContactGroupRule_shape_unique";

-- 4. Drop the old single-column btree index on the scalar tier ---------------
DROP INDEX IF EXISTS "XeroContactGroupRule_ageTier_idx";

-- 5. Drop the retired scalar column ------------------------------------------
ALTER TABLE "XeroContactGroupRule" DROP COLUMN IF EXISTS "ageTier";

-- 6. Defensive shape-dedupe BEFORE the new unique index ----------------------
-- The old index guaranteed uniqueness on (membershipTypeId, ageTier, mode,
-- groupId) and the scalar->array mapping is bijective, so no NEW collision can
-- appear; this DELETE is defensive (matching the E8 precedent) so a lost-race
-- duplicate can never abort the index build. Array `=` treats equal arrays
-- (including two empty arrays) as equal, mirroring the index's array equality;
-- NULLs on membershipTypeId compare equal via IS NOT DISTINCT FROM to mirror
-- NULLS NOT DISTINCT. Keep the earliest (createdAt, id) row per shape.
DELETE FROM "XeroContactGroupRule" AS dup
USING "XeroContactGroupRule" AS keeper
WHERE dup."membershipTypeId" IS NOT DISTINCT FROM keeper."membershipTypeId"
  AND dup."ageTiers" = keeper."ageTiers"
  AND dup."mode" = keeper."mode"
  AND dup."groupId" = keeper."groupId"
  AND (keeper."createdAt", keeper."id") < (dup."createdAt", dup."id");

-- 7. Recreate the rule-shape partial unique index over the array form --------
-- NULLS NOT DISTINCT so two type-wildcard rules with the same stored tier set
-- collide. The index compares stored arrays with order-sensitive btree array
-- equality; reordered tier sets collapse to one shape only because the app
-- writes canonical-sorted arrays (see the header note), not because the index
-- reorders them. Recorded in prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"
  ON "XeroContactGroupRule" ("membershipTypeId", "ageTiers", "mode", "groupId")
  NULLS NOT DISTINCT
  WHERE "groupId" IS NOT NULL;

-- 8. Drop the transitional column default ------------------------------------
-- Matches Prisma's modelled state (list fields have no DB default; the app
-- always writes ageTiers explicitly via canonicalizeAgeTiers). Idempotent:
-- DROP DEFAULT on a column with no default is a no-op.
ALTER TABLE "XeroContactGroupRule" ALTER COLUMN "ageTiers" DROP DEFAULT;
