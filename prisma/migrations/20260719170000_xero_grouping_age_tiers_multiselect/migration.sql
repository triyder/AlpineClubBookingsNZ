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
-- array column. Postgres btree supports array equality natively (array_ops), and
-- because storage is canonical-sorted, [ADULT, YOUTH] == [YOUTH, ADULT] collide
-- as one shape. NULLS NOT DISTINCT still makes two type-wildcard (NULL
-- membershipTypeId) rules with the same tier set collide. The predicate
-- ("groupId" IS NOT NULL — always true) keeps the index invisible to
-- prisma migrate diff / db:check-drift, as with the other partial unique indexes.

-- 1. Add the new array column ------------------------------------------------
-- Prisma models `AgeTier[]` as NOT NULL DEFAULT '{}'.
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
-- NULLS NOT DISTINCT so two type-wildcard rules with the same tier set collide;
-- canonical-sorted storage makes reordered tier sets a single shape. Recorded
-- in prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX IF NOT EXISTS "XeroContactGroupRule_shape_unique"
  ON "XeroContactGroupRule" ("membershipTypeId", "ageTiers", "mode", "groupId")
  NULLS NOT DISTINCT
  WHERE "groupId" IS NOT NULL;
