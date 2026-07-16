-- Pricing engine re-key: hut nightly rates per membership type (#1930, E4).
--
-- Rates and Xero hut-fee item codes move off the member/non-member boolean key
-- and onto a membership-type key. The legacy SeasonRate table and the
-- XeroItemCodeMapping.isMember column are RETAINED (frozen) so day-one
-- resolution stays byte-identical; E13 drops them after a release soak.
--
-- The fan-out backfill (D4) copies:
--   * every isMember=true SeasonRate row  -> every MEMBER_RATE membership type
--     (including archived types, so history stays resolvable),
--   * every isMember=false SeasonRate row -> the built-in NON_MEMBER type only.
-- NON_MEMBER_RATE (except NON_MEMBER itself) and BLOCK_BOOKING types
-- deliberately receive zero own rows (D2 invariant). The same fan-out applies
-- to HUT_FEE XeroItemCodeMapping rows, carrying the old item codes forward.

-- ---------------------------------------------------------------------------
-- 1. MembershipType.ageGroupsApply
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipType"
  ADD COLUMN "ageGroupsApply" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- 2. MembershipTypeSeasonRate
-- ---------------------------------------------------------------------------
CREATE TABLE "MembershipTypeSeasonRate" (
  "id" TEXT NOT NULL,
  "seasonId" TEXT NOT NULL,
  "membershipTypeId" TEXT NOT NULL,
  "ageTier" "AgeTier",
  "pricePerNightCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipTypeSeasonRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipTypeSeasonRate_seasonId_membershipTypeId_ageTier_key"
  ON "MembershipTypeSeasonRate" ("seasonId", "membershipTypeId", "ageTier");
CREATE INDEX "MembershipTypeSeasonRate_seasonId_idx"
  ON "MembershipTypeSeasonRate" ("seasonId");
CREATE INDEX "MembershipTypeSeasonRate_membershipTypeId_idx"
  ON "MembershipTypeSeasonRate" ("membershipTypeId");

-- Prisma cannot express partial (predicated) uniques; Postgres treats NULLs as
-- distinct in the composite unique above, so this raw-SQL partial unique index
-- enforces at most one flat (NULL-ageTier) rate per (season, type). Recorded in
-- prisma/partial-unique-indexes.tsv (CI set-equality gate).
CREATE UNIQUE INDEX "MembershipTypeSeasonRate_seasonId_membershipTypeId_flat_unique"
  ON "MembershipTypeSeasonRate" ("seasonId", "membershipTypeId")
  WHERE ("ageTier" IS NULL);

ALTER TABLE "MembershipTypeSeasonRate"
  ADD CONSTRAINT "MembershipTypeSeasonRate_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "Season" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipTypeSeasonRate"
  ADD CONSTRAINT "MembershipTypeSeasonRate_membershipTypeId_fkey"
  FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. BookingGuest.rateMembershipTypeId (snapshot)
-- ---------------------------------------------------------------------------
ALTER TABLE "BookingGuest"
  ADD COLUMN "rateMembershipTypeId" TEXT;

-- ---------------------------------------------------------------------------
-- 4. XeroItemCodeMapping.membershipTypeId (new HUT_FEE key)
-- ---------------------------------------------------------------------------
ALTER TABLE "XeroItemCodeMapping"
  ADD COLUMN "membershipTypeId" TEXT;

CREATE UNIQUE INDEX "XeroItemCodeMapping_category_membershipTypeId_seasonType_ageTier_key"
  ON "XeroItemCodeMapping" ("category", "membershipTypeId", "seasonType", "ageTier");
CREATE INDEX "XeroItemCodeMapping_membershipTypeId_idx"
  ON "XeroItemCodeMapping" ("membershipTypeId");

-- Partial unique for the flat (NULL-ageTier) HUT_FEE item code. Scoped to
-- category = 'HUT_FEE' so ENTRANCE_FEE rows (which also carry NULL ageTier)
-- are not forced unique across their categories. Recorded in
-- prisma/partial-unique-indexes.tsv.
CREATE UNIQUE INDEX "XeroItemCodeMapping_hutfee_flat_unique"
  ON "XeroItemCodeMapping" ("membershipTypeId", "seasonType")
  WHERE ("ageTier" IS NULL AND "category" = 'HUT_FEE');

-- ---------------------------------------------------------------------------
-- 5. GroupDiscountSetting.rateMembershipTypeId
-- ---------------------------------------------------------------------------
ALTER TABLE "GroupDiscountSetting"
  ADD COLUMN "rateMembershipTypeId" TEXT;

-- ---------------------------------------------------------------------------
-- 6. Fan-out backfill: MembershipTypeSeasonRate (D4, byte-identical day one)
-- ---------------------------------------------------------------------------
-- Member (isMember=true) rows -> every MEMBER_RATE membership type.
INSERT INTO "MembershipTypeSeasonRate"
  ("id", "seasonId", "membershipTypeId", "ageTier", "pricePerNightCents", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  sr."seasonId",
  mt."id",
  sr."ageTier",
  sr."pricePerNightCents",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "SeasonRate" sr
CROSS JOIN "MembershipType" mt
WHERE sr."isMember" = true
  AND mt."bookingBehavior" = 'MEMBER_RATE';

-- Non-member (isMember=false) rows -> the built-in NON_MEMBER type only.
INSERT INTO "MembershipTypeSeasonRate"
  ("id", "seasonId", "membershipTypeId", "ageTier", "pricePerNightCents", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  sr."seasonId",
  mt."id",
  sr."ageTier",
  sr."pricePerNightCents",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "SeasonRate" sr
CROSS JOIN "MembershipType" mt
WHERE sr."isMember" = false
  AND mt."key" = 'NON_MEMBER';

-- ---------------------------------------------------------------------------
-- 7. Fan-out backfill: XeroItemCodeMapping HUT_FEE item codes
-- ---------------------------------------------------------------------------
-- Member (isMember=true) HUT_FEE codes -> every MEMBER_RATE membership type.
INSERT INTO "XeroItemCodeMapping"
  ("id", "category", "ageTier", "seasonType", "isMember", "membershipTypeId", "itemCode", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'HUT_FEE',
  x."ageTier",
  x."seasonType",
  NULL,
  mt."id",
  x."itemCode",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "XeroItemCodeMapping" x
CROSS JOIN "MembershipType" mt
WHERE x."category" = 'HUT_FEE'
  AND x."isMember" = true
  AND mt."bookingBehavior" = 'MEMBER_RATE';

-- Non-member (isMember=false) HUT_FEE codes -> the built-in NON_MEMBER type.
INSERT INTO "XeroItemCodeMapping"
  ("id", "category", "ageTier", "seasonType", "isMember", "membershipTypeId", "itemCode", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'HUT_FEE',
  x."ageTier",
  x."seasonType",
  NULL,
  mt."id",
  x."itemCode",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "XeroItemCodeMapping" x
CROSS JOIN "MembershipType" mt
WHERE x."category" = 'HUT_FEE'
  AND x."isMember" = false
  AND mt."key" = 'NON_MEMBER';

-- ---------------------------------------------------------------------------
-- 8. Seed the group-discount substitution target to the built-in FULL type.
-- ---------------------------------------------------------------------------
UPDATE "GroupDiscountSetting" gds
SET "rateMembershipTypeId" = (
  SELECT mt."id" FROM "MembershipType" mt WHERE mt."key" = 'FULL' LIMIT 1
)
WHERE gds."rateMembershipTypeId" IS NULL;
