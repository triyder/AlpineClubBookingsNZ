-- Add the normalized access-role and membership-type metadata foundations.
-- This is intentionally additive: legacy Member.role and Member.financeAccessLevel
-- remain readable by the previous app version during blue/green cutover.

DO $$
BEGIN
  CREATE TYPE "AccessRole" AS ENUM (
    'USER',
    'ADMIN',
    'LODGE',
    'FINANCE_USER',
    'FINANCE_ADMIN',
    'ORG'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "MembershipAssignmentSource" AS ENUM (
    'ADMIN',
    'IMPORT',
    'FAMILY_SUBSCRIPTION',
    'ROLL_FORWARD',
    'SYSTEM'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "XeroContactGroupRuleMode" AS ENUM (
    'MANAGED',
    'ACCEPTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MemberAccessRole" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "role" "AccessRole" NOT NULL,
  "assignedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemberAccessRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MemberAccessRole_memberId_role_key"
  ON "MemberAccessRole"("memberId", "role");
CREATE INDEX IF NOT EXISTS "MemberAccessRole_role_idx"
  ON "MemberAccessRole"("role");
CREATE INDEX IF NOT EXISTS "MemberAccessRole_assignedByMemberId_idx"
  ON "MemberAccessRole"("assignedByMemberId");

DO $$
BEGIN
  ALTER TABLE "MemberAccessRole"
    ADD CONSTRAINT "MemberAccessRole_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "MemberAccessRole"
    ADD CONSTRAINT "MemberAccessRole_assignedByMemberId_fkey"
    FOREIGN KEY ("assignedByMemberId") REFERENCES "Member"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':USER'),
  m."id",
  'USER'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."role"::text IN ('MEMBER', 'ASSOCIATE', 'LIFE')
ON CONFLICT ("memberId", "role") DO NOTHING;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':ADMIN'),
  m."id",
  'ADMIN'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."role"::text = 'ADMIN'
ON CONFLICT ("memberId", "role") DO NOTHING;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':LODGE'),
  m."id",
  'LODGE'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."role"::text = 'LODGE'
ON CONFLICT ("memberId", "role") DO NOTHING;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':FINANCE_USER'),
  m."id",
  'FINANCE_USER'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."financeAccessLevel"::text = 'VIEWER'
ON CONFLICT ("memberId", "role") DO NOTHING;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':FINANCE_ADMIN'),
  m."id",
  'FINANCE_ADMIN'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."financeAccessLevel"::text = 'MANAGER'
ON CONFLICT ("memberId", "role") DO NOTHING;

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':ORG'),
  m."id",
  'ORG'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."role"::text = 'SCHOOL' AND m."canLogin" = true
ON CONFLICT ("memberId", "role") DO NOTHING;

ALTER TABLE "SeasonalMembershipAssignment"
  ADD COLUMN IF NOT EXISTS "source" "MembershipAssignmentSource" NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN IF NOT EXISTS "sourceDetail" TEXT;

ALTER TABLE "SeasonalMembershipAssignment"
  ALTER COLUMN "source" SET DEFAULT 'ADMIN';

CREATE TABLE IF NOT EXISTS "MembershipTypeAgeTier" (
  "id" TEXT NOT NULL,
  "membershipTypeId" TEXT NOT NULL,
  "ageTier" "AgeTier" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipTypeAgeTier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipTypeAgeTier_membershipTypeId_ageTier_key"
  ON "MembershipTypeAgeTier"("membershipTypeId", "ageTier");
CREATE INDEX IF NOT EXISTS "MembershipTypeAgeTier_ageTier_idx"
  ON "MembershipTypeAgeTier"("ageTier");

DO $$
BEGIN
  ALTER TABLE "MembershipTypeAgeTier"
    ADD CONSTRAINT "MembershipTypeAgeTier_membershipTypeId_fkey"
    FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "XeroContactGroupRule" (
  "id" TEXT NOT NULL,
  "membershipTypeId" TEXT,
  "ageTier" "AgeTier",
  "mode" "XeroContactGroupRuleMode" NOT NULL,
  "groupId" TEXT NOT NULL,
  "groupName" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "XeroContactGroupRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "XeroContactGroupRule_membershipTypeId_idx"
  ON "XeroContactGroupRule"("membershipTypeId");
CREATE INDEX IF NOT EXISTS "XeroContactGroupRule_ageTier_idx"
  ON "XeroContactGroupRule"("ageTier");
CREATE INDEX IF NOT EXISTS "XeroContactGroupRule_mode_isActive_sortOrder_idx"
  ON "XeroContactGroupRule"("mode", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "XeroContactGroupRule_groupId_idx"
  ON "XeroContactGroupRule"("groupId");

DO $$
BEGIN
  ALTER TABLE "XeroContactGroupRule"
    ADD CONSTRAINT "XeroContactGroupRule_membershipTypeId_fkey"
    FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "MembershipType" (
  "id",
  "key",
  "name",
  "description",
  "isActive",
  "isBuiltIn",
  "bookingBehavior",
  "subscriptionBehavior",
  "sortOrder",
  "updatedAt"
) VALUES
  (
    'builtin-membership-type-school',
    'SCHOOL',
    'School',
    'School or education-organisation booking contact. Does not grant member access or annual subscription obligations.',
    true,
    true,
    'NON_MEMBER_RATE',
    'NOT_REQUIRED',
    4,
    CURRENT_TIMESTAMP
  ),
  (
    'builtin-membership-type-non-member',
    'NON_MEMBER',
    'Non-Member',
    'General public or guest contact. Does not grant member access or annual subscription obligations.',
    true,
    true,
    'NON_MEMBER_RATE',
    'NOT_REQUIRED',
    5,
    CURRENT_TIMESTAMP
  ),
  (
    'builtin-membership-type-family',
    'FAMILY',
    'Family',
    'Membership granted through a family subscription or explicit family assignment.',
    true,
    true,
    'MEMBER_RATE',
    'REQUIRED',
    6,
    CURRENT_TIMESTAMP
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
),
legacy_non_member_assignments AS (
  SELECT
    sma."id" AS assignment_id,
    target_type."id" AS target_type_id
  FROM "SeasonalMembershipAssignment" sma
  JOIN "Member" m ON m."id" = sma."memberId"
  JOIN current_membership_season cms ON cms.season_year = sma."seasonYear"
  JOIN "MembershipType" current_type ON current_type."id" = sma."membershipTypeId"
  JOIN "MembershipType" target_type ON target_type."key" = m."role"::text
  WHERE m."role"::text IN ('SCHOOL', 'NON_MEMBER')
    AND current_type."key" = 'FULL'
)
UPDATE "SeasonalMembershipAssignment" sma
SET
  "membershipTypeId" = legacy_non_member_assignments.target_type_id,
  "sourceDetail" = COALESCE(sma."sourceDetail", 'Migrated from legacy non-member Role category.'),
  "updatedAt" = CURRENT_TIMESTAMP
FROM legacy_non_member_assignments
WHERE sma."id" = legacy_non_member_assignments.assignment_id;

-- If a deployment has actually been using Reserve assignments while Associate
-- has not been used, preserve that club-facing label and policy on Associate
-- before merging the rows.
WITH counts AS (
  SELECT
    COALESCE(SUM(CASE WHEN mt."key" = 'ASSOCIATE' THEN sma_count.assignment_count ELSE 0 END), 0) AS associate_count,
    COALESCE(SUM(CASE WHEN mt."key" = 'RESERVE' THEN sma_count.assignment_count ELSE 0 END), 0) AS reserve_count
  FROM "MembershipType" mt
  LEFT JOIN (
    SELECT "membershipTypeId", COUNT(*) AS assignment_count
    FROM "SeasonalMembershipAssignment"
    GROUP BY "membershipTypeId"
  ) sma_count ON sma_count."membershipTypeId" = mt."id"
  WHERE mt."key" IN ('ASSOCIATE', 'RESERVE')
),
reserve_row AS (
  SELECT r.*
  FROM "MembershipType" r, counts
  WHERE r."key" = 'RESERVE'
    AND counts.reserve_count > 0
    AND counts.associate_count = 0
)
UPDATE "MembershipType" associate
SET
  "name" = reserve_row."name",
  "description" = reserve_row."description",
  "bookingBehavior" = reserve_row."bookingBehavior",
  "subscriptionBehavior" = reserve_row."subscriptionBehavior",
  "isActive" = reserve_row."isActive",
  "updatedAt" = CURRENT_TIMESTAMP
FROM reserve_row
WHERE associate."key" = 'ASSOCIATE';

WITH associate_type AS (
  SELECT "id" FROM "MembershipType" WHERE "key" = 'ASSOCIATE'
),
reserve_type AS (
  SELECT "id" FROM "MembershipType" WHERE "key" = 'RESERVE'
)
UPDATE "SeasonalMembershipAssignment" sma
SET
  "membershipTypeId" = associate_type."id",
  "sourceDetail" = COALESCE(sma."sourceDetail", 'Migrated from RESERVE built-in membership type.'),
  "updatedAt" = CURRENT_TIMESTAMP
FROM associate_type, reserve_type
WHERE sma."membershipTypeId" = reserve_type."id";

DELETE FROM "MembershipType"
WHERE "key" = 'RESERVE'
  AND NOT EXISTS (
    SELECT 1
    FROM "SeasonalMembershipAssignment"
    WHERE "membershipTypeId" = "MembershipType"."id"
  );

INSERT INTO "MembershipTypeAgeTier" ("id", "membershipTypeId", "ageTier", "updatedAt")
SELECT
  'membership-type-age-tier-' || md5(mt."id" || ':' || tier.age_tier::text),
  mt."id",
  tier.age_tier::"AgeTier",
  CURRENT_TIMESTAMP
FROM "MembershipType" mt
CROSS JOIN (
  VALUES
    ('FULL', 'INFANT'),
    ('FULL', 'CHILD'),
    ('FULL', 'YOUTH'),
    ('FULL', 'ADULT'),
    ('ASSOCIATE', 'ADULT'),
    ('LIFE', 'ADULT'),
    ('SCHOOL', 'CHILD'),
    ('SCHOOL', 'YOUTH'),
    ('SCHOOL', 'ADULT'),
    ('NON_MEMBER', 'INFANT'),
    ('NON_MEMBER', 'CHILD'),
    ('NON_MEMBER', 'YOUTH'),
    ('NON_MEMBER', 'ADULT'),
    ('FAMILY', 'INFANT'),
    ('FAMILY', 'CHILD'),
    ('FAMILY', 'YOUTH'),
    ('FAMILY', 'ADULT')
) AS tier(type_key, age_tier)
WHERE mt."key" = tier.type_key
ON CONFLICT ("membershipTypeId", "ageTier") DO NOTHING;

INSERT INTO "XeroContactGroupRule" (
  "id",
  "membershipTypeId",
  "ageTier",
  "mode",
  "groupId",
  "groupName",
  "sortOrder",
  "updatedAt"
)
SELECT
  'xero-contact-group-rule-' || md5('age:' || ats."tier"::text || ':managed:' || ats."xeroContactGroupId"),
  NULL,
  ats."tier",
  'MANAGED'::"XeroContactGroupRuleMode",
  ats."xeroContactGroupId",
  ats."xeroContactGroupName",
  ats."sortOrder",
  CURRENT_TIMESTAMP
FROM "AgeTierSetting" ats
WHERE ats."xeroContactGroupId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "XeroContactGroupRule" (
  "id",
  "membershipTypeId",
  "ageTier",
  "mode",
  "groupId",
  "groupName",
  "sortOrder",
  "updatedAt"
)
SELECT
  'xero-contact-group-rule-' || md5('age:' || ats."tier"::text || ':accepted:' || accepted."groupId"),
  NULL,
  ats."tier",
  'ACCEPTED'::"XeroContactGroupRuleMode",
  accepted."groupId",
  accepted."groupName",
  ats."sortOrder",
  CURRENT_TIMESTAMP
FROM "AgeTierXeroAcceptedContactGroup" accepted
JOIN "AgeTierSetting" ats ON ats."id" = accepted."ageTierSettingId"
ON CONFLICT ("id") DO NOTHING;
