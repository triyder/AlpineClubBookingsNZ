-- Double-bed shared occupancy (#1701).
--
-- A DOUBLE bed may hold two occupants for a stay night — one primary and one
-- second occupant (declared partners / same-FamilyGroup adults, admin-placed on
-- the allocation board). Every other bed type stays capped at 1/night. This
-- migration relaxes the bed-night uniqueness in a DB-enforced, blue/green-safe
-- way, with NO CHECK constraints (their drift-cleanliness is unverified):
--
--   1. Add isSecondOccupant (default false) and a denormalized bedType (default
--      SINGLE). Both defaults keep old code correct during a blue/green window:
--      an old-code insert lands isSecondOccupant=false (so the relaxed composite
--      unique below still behaves like the old 1-row-per-bed-night rule) and a
--      bedType that the partial index treats as non-double (so it can never
--      create a second occupant). ADD COLUMN ... DEFAULT is non-breaking.
--   2. Backfill bedType on existing rows from the owning LodgeBed so the partial
--      index reflects real bed types (not the SINGLE column default).
--   3. Replace @@unique([bedId, stayDate]) with
--      @@unique([bedId, stayDate, isSecondOccupant]) — ≤1 primary + ≤1 second
--      ⇒ ≤2 rows per bed-night for every bed type.
--   4. Add a raw-SQL PARTIAL unique index capping NON-DOUBLE beds at exactly 1
--      row/night. Prisma cannot express partial indexes and prisma migrate diff
--      (db:check-drift) does not surface them, so this does not trip the drift
--      gate — same precedent as Member_email_login_unique and the club-wide
--      CancellationPolicy/LodgeInstruction indexes. It is recorded in
--      prisma/partial-unique-indexes.tsv, which the migration-drift job's
--      check-partial-indexes.sh enforces by set-equality.
--
-- Net DB guarantees: non-double ≤1/night, double ≤2/night — both enforced,
-- zero CHECK constraints. The domain rule "isSecondOccupant ⇒ bed is DOUBLE"
-- stays app-level (a uniqueness index cannot express it); worst case a bug
-- leaves a harmless lone second-occupant row, never over-occupancy on a
-- non-double bed. BedAllocation is not a blue/green hot table and this migration
-- carries no breaking SQL (no DROP COLUMN / SET NOT NULL / rename), so it needs
-- no safety-ledger entry.

-- DropIndex
DROP INDEX "BedAllocation_bedId_stayDate_key";

-- AlterTable
ALTER TABLE "BedAllocation" ADD COLUMN     "bedType" "BedType" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "isSecondOccupant" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the denormalized bedType from the owning bed (existing rows only;
-- new rows are set explicitly by the allocation code). Every BedAllocation has a
-- valid bedId (FK, ON DELETE RESTRICT), so every row is covered.
UPDATE "BedAllocation" a
SET "bedType" = b."bedType"
FROM "LodgeBed" b
WHERE a."bedId" = b."id";

-- CreateIndex
CREATE UNIQUE INDEX "BedAllocation_bedId_stayDate_isSecondOccupant_key" ON "BedAllocation"("bedId", "stayDate", "isSecondOccupant");

-- CreateIndex (raw-SQL partial: non-DOUBLE beds stay 1 row per bed-night)
CREATE UNIQUE INDEX "BedAllocation_nonDouble_bedId_stayDate_unique"
  ON "BedAllocation" ("bedId", "stayDate")
  WHERE "bedType" <> 'DOUBLE';
