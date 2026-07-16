-- Joining-fee model: EntranceFee rename + re-key to membership type x age tier
-- (#1931, E5).
--
-- The one-off "entrance fee" becomes the "joining fee", keyed by membership
-- type x optional age tier instead of the age-driven category enum. The legacy
-- EntranceFee table and the XeroItemCodeMapping ENTRANCE_FEE amounts are the
-- SOURCE of the day-one backfill; EntranceFee is RETAINED unused (E13 drops it
-- after a release soak). Money stays integer cents; dates stay date-only.
--
-- Fan-out backfill (owner decision D-R1): the old per-category amounts are
-- copied to EVERY joining-fee-liable membership type (all types except the
-- built-in NON_MEMBER and SCHOOL, INCLUDING archived liable types so history
-- stays resolvable):
--   * ADULT amount -> the ADULT tier of every liable per-tier type,
--   * YOUTH amount -> the YOUTH tier,
--   * CHILD amount -> BOTH the CHILD and INFANT tiers (INFANT folds onto CHILD),
--   * FAMILY amount -> the built-in Family type as a single flat NULL-tier row.
-- The Family type is excluded from the per-tier fan-out: a Family member of any
-- age resolves the flat family fee (age-tier lookup misses, flat row wins).
-- Effective windows are carried over verbatim, so every member's resolved
-- amount is byte-identical on day one (the family fee becoming strictly
-- type-driven is the one deliberate behaviour change, surfaced in code/docs).
--
-- Migration pre-check (coverage-based): where an install still depends on a
-- legacy mapping amount for a category with NO EntranceFee window COVERING the
-- migration day (none at all, all lapsed, or all future), that amount is
-- MATERIALISED here into JoiningFee rather than left to a runtime fallback
-- (the runtime fallback is removed in this release). The removed fallback
-- applied whenever no window was ACTIVE as-of today — so a lapsed-window-plus-
-- legacy-amount install must keep billing, not just a row-less one. The
-- materialised window opens on the migration day and is bounded to the day
-- before the category's earliest FUTURE window (if any) so it never overlaps a
-- scheduled fee. Categories that legitimately have no fee produce no rows.

-- ---------------------------------------------------------------------------
-- 1. JoiningFee table
-- ---------------------------------------------------------------------------
CREATE TABLE "JoiningFee" (
  "id" TEXT NOT NULL,
  "membershipTypeId" TEXT NOT NULL,
  "ageTier" "AgeTier",
  "amountCents" INTEGER NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JoiningFee_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JoiningFee_amount_nonnegative" CHECK ("amountCents" >= 0),
  CONSTRAINT "JoiningFee_date_order" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX "JoiningFee_membershipTypeId_ageTier_effectiveFrom_key"
  ON "JoiningFee" ("membershipTypeId", "ageTier", "effectiveFrom");
CREATE INDEX "JoiningFee_effective_lookup_idx"
  ON "JoiningFee" ("membershipTypeId", "ageTier", "effectiveFrom", "effectiveTo");

-- Prisma cannot express partial (predicated) uniques; Postgres treats NULLs as
-- distinct in the composite unique above, so this raw-SQL partial unique index
-- enforces at most one flat (NULL-ageTier) joining-fee window per (type,
-- effectiveFrom). Recorded in prisma/partial-unique-indexes.tsv (CI
-- set-equality gate).
CREATE UNIQUE INDEX "JoiningFee_membershipTypeId_flat_effectiveFrom_unique"
  ON "JoiningFee" ("membershipTypeId", "effectiveFrom")
  WHERE ("ageTier" IS NULL);

ALTER TABLE "JoiningFee"
  ADD CONSTRAINT "JoiningFee_membershipTypeId_fkey"
  FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Fan-out backfill (D-R1)
-- ---------------------------------------------------------------------------
-- Source windows: every EntranceFee schedule row verbatim, plus (for any
-- category with NO schedule row) one open window materialised from the legacy
-- mapping amount (per-category XeroItemCodeMapping amount first, then the global
-- XeroAccountMapping 'entranceFeeAmountCents' flat amount). All INSERTs write an
-- explicit UTC updatedAt via timezone('UTC', statement_timestamp()); the only
-- session-derived value is the honest Pacific/Auckland boundary date used for a
-- materialised legacy window (the legacy mappings never retained a start date).

WITH cats AS (
  SELECT unnest(enum_range(NULL::"EntranceFeeCategory")) AS category
),
legacy_mapping AS (
  SELECT
    x."entranceFeeCategory" AS category,
    x."amountCents" AS amount
  FROM "XeroItemCodeMapping" x
  WHERE x."category" = 'ENTRANCE_FEE'
    AND x."entranceFeeCategory" IS NOT NULL
    AND x."amountCents" IS NOT NULL
    AND x."amountCents" >= 0
),
legacy_global_text AS (
  SELECT "code"
  FROM "XeroAccountMapping"
  WHERE "key" = 'entranceFeeAmountCents'
    AND "code" ~ '^[0-9]{1,10}$'
),
legacy_global AS (
  SELECT "code"::bigint AS amount
  FROM legacy_global_text
  WHERE "code"::bigint <= 2147483647
),
src AS (
  -- Schedule rows verbatim (windows preserved).
  SELECT
    e."category" AS category,
    e."amountCents" AS amount,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  UNION ALL
  -- Legacy materialisation for categories with no window COVERING the
  -- migration day (none, all lapsed, or all future) — the removed runtime
  -- fallback applied whenever no window was ACTIVE as-of today, so this keeps
  -- a lapsed-window-plus-legacy-amount install billing. The new open window
  -- is bounded to the day before the category's earliest FUTURE window so it
  -- never overlaps a scheduled fee.
  SELECT
    c.category,
    COALESCE(lm.amount, lg.amount)::integer AS amount,
    timezone('Pacific/Auckland', statement_timestamp())::date AS "effectiveFrom",
    (SELECT MIN(e3."effectiveFrom") - 1
       FROM "EntranceFee" e3
      WHERE e3."category" = c.category
        AND e3."effectiveFrom" > timezone('Pacific/Auckland', statement_timestamp())::date
    ) AS "effectiveTo"
  FROM cats c
  LEFT JOIN legacy_mapping lm ON lm.category = c.category
  LEFT JOIN legacy_global lg ON TRUE
  WHERE NOT EXISTS (
      SELECT 1 FROM "EntranceFee" e2
      WHERE e2."category" = c.category
        AND e2."effectiveFrom" <= timezone('Pacific/Auckland', statement_timestamp())::date
        AND (e2."effectiveTo" IS NULL
             OR e2."effectiveTo" >= timezone('Pacific/Auckland', statement_timestamp())::date)
    )
    AND COALESCE(lm.amount, lg.amount) IS NOT NULL
    AND COALESCE(lm.amount, lg.amount) > 0
),
-- Per-tier fan-out targets: every joining-fee-liable membership type except the
-- built-in Family type (which carries only the flat family fee below). Archived
-- (isActive = false) liable types are intentionally included.
pertier_types AS (
  SELECT mt."id"
  FROM "MembershipType" mt
  WHERE mt."key" NOT IN ('NON_MEMBER', 'SCHOOL', 'FAMILY')
)
INSERT INTO "JoiningFee"
  ("id", "membershipTypeId", "ageTier", "amountCents", "effectiveFrom", "effectiveTo", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  tier.tier,
  s.amount,
  s."effectiveFrom",
  s."effectiveTo",
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
FROM src s
CROSS JOIN pertier_types t
CROSS JOIN LATERAL (
  -- Category -> target age tier(s); FAMILY yields no per-tier rows (handled by
  -- the flat fan-out), CHILD folds onto BOTH CHILD and INFANT.
  SELECT unnest(
    CASE s.category
      WHEN 'ADULT' THEN ARRAY['ADULT']::"AgeTier"[]
      WHEN 'YOUTH' THEN ARRAY['YOUTH']::"AgeTier"[]
      WHEN 'CHILD' THEN ARRAY['CHILD', 'INFANT']::"AgeTier"[]
      ELSE ARRAY[]::"AgeTier"[]
    END
  ) AS tier
) tier
ON CONFLICT DO NOTHING;

-- Flat family fee -> the built-in Family type only (NULL age tier).
WITH cats AS (
  SELECT unnest(enum_range(NULL::"EntranceFeeCategory")) AS category
),
legacy_mapping AS (
  SELECT
    x."entranceFeeCategory" AS category,
    x."amountCents" AS amount
  FROM "XeroItemCodeMapping" x
  WHERE x."category" = 'ENTRANCE_FEE'
    AND x."entranceFeeCategory" IS NOT NULL
    AND x."amountCents" IS NOT NULL
    AND x."amountCents" >= 0
),
legacy_global_text AS (
  SELECT "code"
  FROM "XeroAccountMapping"
  WHERE "key" = 'entranceFeeAmountCents'
    AND "code" ~ '^[0-9]{1,10}$'
),
legacy_global AS (
  SELECT "code"::bigint AS amount
  FROM legacy_global_text
  WHERE "code"::bigint <= 2147483647
),
src AS (
  SELECT
    e."category" AS category,
    e."amountCents" AS amount,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  UNION ALL
  -- Same coverage-based legacy materialisation as the per-tier statement
  -- above (see that comment for the rationale).
  SELECT
    c.category,
    COALESCE(lm.amount, lg.amount)::integer AS amount,
    timezone('Pacific/Auckland', statement_timestamp())::date AS "effectiveFrom",
    (SELECT MIN(e3."effectiveFrom") - 1
       FROM "EntranceFee" e3
      WHERE e3."category" = c.category
        AND e3."effectiveFrom" > timezone('Pacific/Auckland', statement_timestamp())::date
    ) AS "effectiveTo"
  FROM cats c
  LEFT JOIN legacy_mapping lm ON lm.category = c.category
  LEFT JOIN legacy_global lg ON TRUE
  WHERE NOT EXISTS (
      SELECT 1 FROM "EntranceFee" e2
      WHERE e2."category" = c.category
        AND e2."effectiveFrom" <= timezone('Pacific/Auckland', statement_timestamp())::date
        AND (e2."effectiveTo" IS NULL
             OR e2."effectiveTo" >= timezone('Pacific/Auckland', statement_timestamp())::date)
    )
    AND COALESCE(lm.amount, lg.amount) IS NOT NULL
    AND COALESCE(lm.amount, lg.amount) > 0
)
INSERT INTO "JoiningFee"
  ("id", "membershipTypeId", "ageTier", "amountCents", "effectiveFrom", "effectiveTo", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  mt."id",
  NULL,
  s.amount,
  s."effectiveFrom",
  s."effectiveTo",
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
FROM src s
CROSS JOIN "MembershipType" mt
WHERE s.category = 'FAMILY'
  AND mt."key" = 'FAMILY'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Re-key the ENTRANCE_FEE Xero item-code rows to JOINING_FEE
-- ---------------------------------------------------------------------------
-- The joining-fee invoice line still resolves its Xero item code from this
-- table (keyed by entranceFeeCategory); only the category label changes, so the
-- item code carried forward is byte-identical. Amounts on these rows are now
-- superseded by JoiningFee and no longer read at runtime.
UPDATE "XeroItemCodeMapping"
SET "category" = 'JOINING_FEE',
    "updatedAt" = timezone('UTC', statement_timestamp())
WHERE "category" = 'ENTRANCE_FEE';
