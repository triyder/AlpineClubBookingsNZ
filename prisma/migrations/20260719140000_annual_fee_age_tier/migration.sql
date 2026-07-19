-- Per-age-tier annual membership fees (#2067): give MembershipAnnualFee the same
-- "Flat (all ages)" vs per-tier shape the joining fee already carries (#1931,
-- E5), keyed by membership type x optional age tier. Per-tier rows win at
-- resolution time; the flat NULL-tier row is the fallback.
--
-- EXPAND-ONLY, no DML. The nullable ageTier column is added with NO backfill:
-- every existing MembershipAnnualFee row keeps ageTier NULL and IS the flat row,
-- so day-one resolution stays byte-identical (a member of any tier resolves the
-- flat row when the type has no per-tier row). Money stays integer cents; dates
-- stay date-only. No now()/CURRENT_TIMESTAMP is used anywhere (session-clock
-- gate): this migration writes no rows, so it needs no timestamps.
--
-- Blue/green: OLD code has no ageTier field and reads/writes only the flat rows,
-- so it is unaffected by the additive column; do NOT create per-tier rows until
-- the cutover completes (a per-tier row is invisible to the OLD colour and would
-- under-resolve to the flat fallback there). See
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.

-- ---------------------------------------------------------------------------
-- 1. Nullable ageTier column (NULL = the flat, whole-type fee)
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipAnnualFee" ADD COLUMN "ageTier" "AgeTier";

-- ---------------------------------------------------------------------------
-- 2. Re-key the uniqueness from (type, effectiveFrom) to (type, ageTier,
--    effectiveFrom). Postgres treats NULLs as distinct in a composite unique,
--    so a raw-SQL partial unique index (WHERE "ageTier" IS NULL) enforces at
--    most one flat window per (type, effectiveFrom) — mirroring
--    JoiningFee_membershipTypeId_flat_effectiveFrom_unique. Recorded in
--    prisma/partial-unique-indexes.tsv (CI set-equality gate).
-- ---------------------------------------------------------------------------
DROP INDEX "MembershipAnnualFee_membershipTypeId_effectiveFrom_key";
CREATE UNIQUE INDEX "MembershipAnnualFee_membershipTypeId_ageTier_effectiveFrom_key"
  ON "MembershipAnnualFee" ("membershipTypeId", "ageTier", "effectiveFrom");
CREATE UNIQUE INDEX "MembershipAnnualFee_membershipTypeId_flat_effectiveFrom_unique"
  ON "MembershipAnnualFee" ("membershipTypeId", "effectiveFrom")
  WHERE ("ageTier" IS NULL);

-- ---------------------------------------------------------------------------
-- 3. Widen the effective-lookup index to include ageTier (the resolver now
--    filters by membershipTypeId x ageTier x window).
-- ---------------------------------------------------------------------------
DROP INDEX "MembershipAnnualFee_effective_lookup_idx";
CREATE INDEX "MembershipAnnualFee_effective_lookup_idx"
  ON "MembershipAnnualFee" ("membershipTypeId", "ageTier", "effectiveFrom", "effectiveTo");

-- ---------------------------------------------------------------------------
-- 4. Re-scope the GiST no-overlap EXCLUDE from per-type to per-(type, tier).
--    The pre-existing constraint forbade ANY two overlapping windows for one
--    type, which would reject a legitimate Adult + Youth pair in the same
--    window. COALESCE("ageTier"::text, '') makes two flat (NULL) rows compare
--    EQUAL (so overlapping flat windows still conflict — the guarantee
--    config-transfer relies on, since it writes directly and bypasses the API
--    overlap check) while a flat row and a per-tier row, or two different-tier
--    rows, never conflict. btree_gist is already installed (migration
--    20260713110000).
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipAnnualFee" DROP CONSTRAINT "MembershipAnnualFee_no_overlap";
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_no_overlap"
  EXCLUDE USING gist (
    "membershipTypeId" WITH =,
    (COALESCE("ageTier"::text, '')) WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&
  );

-- ---------------------------------------------------------------------------
-- 5. PER_FAMILY fees stay flat-only (owner decision, #2067). A per-family fee
--    bills a family once regardless of any member's age, so a per-tier
--    per-family row is meaningless; per-tier rows are allowed only for
--    PER_MEMBER (and NO_INVOICE) bases. Enforced three ways (API 409, this DB
--    CHECK, config-transfer plan-time row error).
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_family_flat_only"
  CHECK (NOT ("billingBasis" = 'PER_FAMILY' AND "ageTier" IS NOT NULL));
