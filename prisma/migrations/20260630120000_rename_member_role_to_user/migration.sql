-- Finalize the Access Roles naming contract before deployment.
--
-- The preceding Access Roles migration was merged but has not been deployed to
-- a live environment. Keep this migration tolerant of local/dev databases that
-- may already have applied it: preserve normalized USER access rows, then
-- collapse the legacy Member.role enum value MEMBER and the one-day
-- ASSOCIATE/LIFE category values into USER. Seasonal MembershipType records
-- remain the category source of truth.

INSERT INTO "MemberAccessRole" ("id", "memberId", "role", "updatedAt")
SELECT
  'member-access-role-' || md5(m."id" || ':USER'),
  m."id",
  'USER'::"AccessRole",
  CURRENT_TIMESTAMP
FROM "Member" m
WHERE m."role"::text IN ('MEMBER', 'USER', 'ASSOCIATE', 'LIFE')
ON CONFLICT ("memberId", "role") DO NOTHING;

ALTER TABLE "Member" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Member" ALTER COLUMN "role" TYPE TEXT USING "role"::text;

UPDATE "Member"
SET "role" = 'USER'
WHERE "role" IN ('MEMBER', 'ASSOCIATE', 'LIFE');

DROP TYPE "Role";
CREATE TYPE "Role" AS ENUM (
  'USER',
  'ADMIN',
  'LODGE',
  'NON_MEMBER',
  'SCHOOL'
);

ALTER TABLE "Member"
  ALTER COLUMN "role" TYPE "Role" USING "role"::"Role";

ALTER TABLE "Member" ALTER COLUMN "role" SET DEFAULT 'USER';
