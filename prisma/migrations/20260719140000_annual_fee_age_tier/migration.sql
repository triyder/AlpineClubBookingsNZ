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
-- Blue/green: OLD code has no ageTier field and resolves fees without filtering
-- on ageTier (pre-cutover every row is flat, so it reads/writes only the flat
-- rows), unaffected by the additive column; do NOT create per-tier rows until the
-- cutover completes — the OLD resolver does not filter by ageTier, so a per-tier
-- row is NOT invisible to it: it could be SELECTed for ANY member regardless of
-- tier and mis-price them (over-resolve). See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.

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
--    window. We CANNOT re-scope it with COALESCE("ageTier"::text, '') because an
--    enum->text cast is only STABLE (enum labels can be renamed), and Postgres
--    forbids non-IMMUTABLE functions in an index/EXCLUDE expression (SQLSTATE
--    42P17). Instead, split into TWO PARTIAL EXCLUDE constraints with the same
--    combined semantics:
--      * flat rows (ageTier IS NULL): key on (type, daterange) only — the exact
--        pre-#2067 constraint, so two overlapping FLAT windows for one type still
--        conflict (the guarantee config-transfer relies on, since it writes
--        directly and bypasses the API overlap check). NULL ageTier is never in
--        the key, so no cast is needed.
--      * tier rows (ageTier IS NOT NULL): add "ageTier" WITH = — btree_gist
--        supports enum equality natively on PG16, no cast — so two overlapping
--        SAME-tier windows conflict while two DIFFERENT-tier windows coexist.
--    A flat row and a per-tier row live in different partial constraints (each
--    other's WHERE excludes them), so they never conflict. Net result is
--    byte-identical to the intended COALESCE form. The daterange expression is
--    copied verbatim from the pre-#2067 constraint. btree_gist is already
--    installed (migration 20260713110000).
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipAnnualFee" DROP CONSTRAINT "MembershipAnnualFee_no_overlap";
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_flat_no_overlap"
  EXCLUDE USING gist (
    "membershipTypeId" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&
  ) WHERE ("ageTier" IS NULL);
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_tier_no_overlap"
  EXCLUDE USING gist (
    "membershipTypeId" WITH =,
    "ageTier" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&
  ) WHERE ("ageTier" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 5. PER_FAMILY fees stay flat-only (owner decision, #2067). A per-family fee
--    bills a family once regardless of any member's age, so a per-tier
--    per-family row is meaningless; per-tier rows are allowed only for
--    PER_MEMBER (and NO_INVOICE) bases. Enforced three ways (API 409, this DB
--    CHECK, config-transfer plan-time row error).
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_family_flat_only"
  CHECK (NOT ("billingBasis" = 'PER_FAMILY' AND "ageTier" IS NOT NULL));
