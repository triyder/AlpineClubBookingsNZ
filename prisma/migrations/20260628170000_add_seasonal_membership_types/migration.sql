-- Add seasonal membership type foundation without changing access-role,
-- booking, subscription lockout, or Xero behavior.

DO $$
BEGIN
  CREATE TYPE "MembershipTypeBookingBehavior" AS ENUM (
    'MEMBER_RATE',
    'NON_MEMBER_RATE',
    'BLOCK_BOOKING'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "MembershipTypeSubscriptionBehavior" AS ENUM (
    'REQUIRED',
    'NOT_REQUIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MembershipType" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
  "bookingBehavior" "MembershipTypeBookingBehavior" NOT NULL DEFAULT 'MEMBER_RATE',
  "subscriptionBehavior" "MembershipTypeSubscriptionBehavior" NOT NULL DEFAULT 'REQUIRED',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipType_key_key"
  ON "MembershipType"("key");
CREATE INDEX IF NOT EXISTS "MembershipType_isActive_sortOrder_idx"
  ON "MembershipType"("isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "MembershipType_sortOrder_idx"
  ON "MembershipType"("sortOrder");

CREATE TABLE IF NOT EXISTS "SeasonalMembershipAssignment" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "seasonYear" INTEGER NOT NULL,
  "membershipTypeId" TEXT NOT NULL,
  "assignedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SeasonalMembershipAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SeasonalMembershipAssignment_memberId_seasonYear_key"
  ON "SeasonalMembershipAssignment"("memberId", "seasonYear");
CREATE INDEX IF NOT EXISTS "SeasonalMembershipAssignment_seasonYear_idx"
  ON "SeasonalMembershipAssignment"("seasonYear");
CREATE INDEX IF NOT EXISTS "SeasonalMembershipAssignment_membershipTypeId_idx"
  ON "SeasonalMembershipAssignment"("membershipTypeId");
CREATE INDEX IF NOT EXISTS "SeasonalMembershipAssignment_seasonYear_membershipTypeId_idx"
  ON "SeasonalMembershipAssignment"("seasonYear", "membershipTypeId");
CREATE INDEX IF NOT EXISTS "SeasonalMembershipAssignment_assignedByMemberId_idx"
  ON "SeasonalMembershipAssignment"("assignedByMemberId");

ALTER TABLE "SeasonalMembershipAssignment"
  ADD CONSTRAINT "SeasonalMembershipAssignment_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeasonalMembershipAssignment"
  ADD CONSTRAINT "SeasonalMembershipAssignment_membershipTypeId_fkey"
  FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SeasonalMembershipAssignment"
  ADD CONSTRAINT "SeasonalMembershipAssignment_assignedByMemberId_fkey"
  FOREIGN KEY ("assignedByMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "MembershipType" (
  "id",
  "key",
  "name",
  "description",
  "isActive",
  "isBuiltIn",
  "bookingBehavior",
  "subscriptionBehavior",
  "sortOrder"
) VALUES
  (
    'builtin-membership-type-full',
    'FULL',
    'Full',
    'Default full club membership.',
    true,
    true,
    'MEMBER_RATE',
    'REQUIRED',
    0
  ),
  (
    'builtin-membership-type-associate',
    'ASSOCIATE',
    'Associate',
    'Associate membership starts with non-member booking-rate policy until enforcement is enabled.',
    true,
    true,
    'NON_MEMBER_RATE',
    'REQUIRED',
    1
  ),
  (
    'builtin-membership-type-reserve',
    'RESERVE',
    'Reserve',
    'Reserve membership starts with booking blocked until enforcement is enabled.',
    true,
    true,
    'BLOCK_BOOKING',
    'REQUIRED',
    2
  ),
  (
    'builtin-membership-type-life',
    'LIFE',
    'Life',
    'Life membership starts with member booking-rate policy and no annual subscription requirement.',
    true,
    true,
    'MEMBER_RATE',
    'NOT_REQUIRED',
    3
  )
ON CONFLICT ("key") DO UPDATE
SET "isBuiltIn" = true;

WITH financial_year_config AS (
  SELECT COALESCE(
    (
      SELECT "financialYearEndMonthOverride"
      FROM "MembershipLockoutSettings"
      WHERE "id" = 'default'
    ),
    3
  ) AS financial_year_end_month
),
current_membership_season AS (
  SELECT
    CASE
      WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int >= ((financial_year_end_month % 12) + 1)
        THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
      ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1
    END AS season_year
  FROM financial_year_config
)
INSERT INTO "SeasonalMembershipAssignment" (
  "id",
  "memberId",
  "seasonYear",
  "membershipTypeId"
)
SELECT
  'seasonal-membership-' || md5(m."id" || ':' || cms.season_year::text),
  m."id",
  cms.season_year,
  mt."id"
FROM "Member" m
CROSS JOIN current_membership_season cms
JOIN "MembershipType" mt
  ON mt."key" = CASE m."role"::text
    WHEN 'ASSOCIATE' THEN 'ASSOCIATE'
    WHEN 'LIFE' THEN 'LIFE'
    ELSE 'FULL'
  END
ON CONFLICT ("memberId", "seasonYear") DO NOTHING;
