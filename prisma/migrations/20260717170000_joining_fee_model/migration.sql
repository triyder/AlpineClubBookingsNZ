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
-- Migration pre-check (gap-fill, #1931 F1): the removed runtime fallback
-- (getEffectiveEntranceFee) billed the legacy mapping amount on EVERY date no
-- EntranceFee window covered — an UNCONDITIONAL uncovered-date fallback, not
-- merely a fallback for row-less installs. To preserve that behaviour exactly
-- now the fallback is gone, where a legacy amount exists this materialises a
-- legacy-amount JoiningFee window over EVERY gap in the migration-day-onward
-- date line that no explicit EntranceFee window covers:
--   * the LEADING gap before the earliest relevant window,
--   * each INTER-WINDOW gap between two scheduled windows, and
--   * the open TAIL after a bounded last window (and the whole open line when no
--     relevant window exists at all).
-- Materialised windows are the complement of the schedule windows, so they never
-- overlap a scheduled fee; the resolved joining fee for any date >= the
-- migration day therefore equals what getEffectiveEntranceFee returned on the
-- old runtime. Categories with no legacy amount produce no rows (they stay
-- fee-free and resolve NONE, unchanged).

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
-- category with a legacy mapping amount) one legacy-amount window PER uncovered
-- gap in the migration-day-onward date line — the complement of the schedule
-- windows (per-category XeroItemCodeMapping amount first, then the global
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
-- The single legacy amount for a category: per-category XeroItemCodeMapping
-- amount first, then the global flat XeroAccountMapping amount. NULL when the
-- install never carried a legacy amount for that category (then it stays
-- fee-free — no gap windows are generated below).
legacy_amount AS (
  SELECT c.category, COALESCE(lm.amount, lg.amount)::integer AS amount
  FROM cats c
  LEFT JOIN legacy_mapping lm ON lm.category = c.category
  LEFT JOIN legacy_global lg ON TRUE
),
-- EntranceFee windows still relevant to the migration-day-onward date line:
-- open-ended, or ending on/after the migration day. Purely past windows are
-- irrelevant (nothing joins in the past) and are ignored.
rel AS (
  SELECT
    e."category" AS category,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  WHERE e."effectiveTo" IS NULL
     OR e."effectiveTo" >= timezone('Pacific/Auckland', statement_timestamp())::date
),
-- Complement of the relevant windows within [migration-day, +infinity): one row
-- per gap no explicit window covers.
--   (a) leading gap  [migration-day, earliest relevant window start - 1],
--   (b) inter-window gap [bounded window end + 1, next window start - 1],
--   (c) open tail    [bounded last window end + 1, +infinity),
--   (d) whole line   [migration-day, +infinity) when no relevant window exists.
gaps AS (
  -- (a) leading gap, only when the earliest relevant window starts after the
  -- migration day (i.e. no window covers the migration day itself).
  SELECT
    r.category,
    timezone('Pacific/Auckland', statement_timestamp())::date AS gap_from,
    MIN(GREATEST(r."effectiveFrom", timezone('Pacific/Auckland', statement_timestamp())::date)) - 1 AS gap_to
  FROM rel r
  GROUP BY r.category
  HAVING MIN(GREATEST(r."effectiveFrom", timezone('Pacific/Auckland', statement_timestamp())::date))
         > timezone('Pacific/Auckland', statement_timestamp())::date
  UNION ALL
  -- (b) inter-window gap and (c) open tail: for each bounded relevant window, the
  -- span from the day after it ends up to the day before the NEXT relevant
  -- window (or +infinity when it is the last). NULL gap_to encodes the open tail.
  SELECT
    r.category,
    r."effectiveTo" + 1 AS gap_from,
    (SELECT MIN(r2."effectiveFrom")
       FROM rel r2
      WHERE r2.category = r.category
        AND r2."effectiveFrom" > r."effectiveTo") - 1 AS gap_to
  FROM rel r
  WHERE r."effectiveTo" IS NOT NULL
  UNION ALL
  -- (d) whole open line for a category with no relevant window at all.
  SELECT
    c.category,
    timezone('Pacific/Auckland', statement_timestamp())::date AS gap_from,
    NULL::date AS gap_to
  FROM cats c
  WHERE NOT EXISTS (SELECT 1 FROM rel r WHERE r.category = c.category)
),
src AS (
  -- Schedule rows verbatim (windows preserved; day-one amounts byte-identical).
  SELECT
    e."category" AS category,
    e."amountCents" AS amount,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  UNION ALL
  -- Legacy materialisation: fill EVERY uncovered gap with the category's legacy
  -- amount, reproducing the removed uncovered-date runtime fallback. Empty gaps
  -- between adjacent windows are dropped; open tails (gap_to NULL) are kept.
  SELECT
    g.category,
    la.amount AS amount,
    g.gap_from AS "effectiveFrom",
    g.gap_to AS "effectiveTo"
  FROM gaps g
  JOIN legacy_amount la ON la.category = g.category
  WHERE la.amount IS NOT NULL
    AND la.amount > 0
    AND (g.gap_to IS NULL OR g.gap_to >= g.gap_from)
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
legacy_amount AS (
  SELECT c.category, COALESCE(lm.amount, lg.amount)::integer AS amount
  FROM cats c
  LEFT JOIN legacy_mapping lm ON lm.category = c.category
  LEFT JOIN legacy_global lg ON TRUE
),
rel AS (
  SELECT
    e."category" AS category,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  WHERE e."effectiveTo" IS NULL
     OR e."effectiveTo" >= timezone('Pacific/Auckland', statement_timestamp())::date
),
-- Same gap complement as the per-tier statement above (see that comment for the
-- leading / inter-window / open-tail / whole-line rationale).
gaps AS (
  SELECT
    r.category,
    timezone('Pacific/Auckland', statement_timestamp())::date AS gap_from,
    MIN(GREATEST(r."effectiveFrom", timezone('Pacific/Auckland', statement_timestamp())::date)) - 1 AS gap_to
  FROM rel r
  GROUP BY r.category
  HAVING MIN(GREATEST(r."effectiveFrom", timezone('Pacific/Auckland', statement_timestamp())::date))
         > timezone('Pacific/Auckland', statement_timestamp())::date
  UNION ALL
  SELECT
    r.category,
    r."effectiveTo" + 1 AS gap_from,
    (SELECT MIN(r2."effectiveFrom")
       FROM rel r2
      WHERE r2.category = r.category
        AND r2."effectiveFrom" > r."effectiveTo") - 1 AS gap_to
  FROM rel r
  WHERE r."effectiveTo" IS NOT NULL
  UNION ALL
  SELECT
    c.category,
    timezone('Pacific/Auckland', statement_timestamp())::date AS gap_from,
    NULL::date AS gap_to
  FROM cats c
  WHERE NOT EXISTS (SELECT 1 FROM rel r WHERE r.category = c.category)
),
src AS (
  SELECT
    e."category" AS category,
    e."amountCents" AS amount,
    e."effectiveFrom" AS "effectiveFrom",
    e."effectiveTo" AS "effectiveTo"
  FROM "EntranceFee" e
  UNION ALL
  SELECT
    g.category,
    la.amount AS amount,
    g.gap_from AS "effectiveFrom",
    g.gap_to AS "effectiveTo"
  FROM gaps g
  JOIN legacy_amount la ON la.category = g.category
  WHERE la.amount IS NOT NULL
    AND la.amount > 0
    AND (g.gap_to IS NULL OR g.gap_to >= g.gap_from)
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
