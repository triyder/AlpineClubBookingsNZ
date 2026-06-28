-- Add committee master roles and member-linked assignments while preserving
-- existing legacy CommitteeMember rows that still power the public committee
-- page until the public privacy follow-up lands.

CREATE TABLE IF NOT EXISTS "CommitteeRole" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommitteeRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommitteeRole_key_key"
  ON "CommitteeRole"("key");
CREATE INDEX IF NOT EXISTS "CommitteeRole_isActive_sortOrder_idx"
  ON "CommitteeRole"("isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "CommitteeRole_sortOrder_idx"
  ON "CommitteeRole"("sortOrder");

CREATE TABLE IF NOT EXISTS "CommitteeAssignment" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "committeeRoleId" TEXT NOT NULL,
  "blurb" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "showPhone" BOOLEAN NOT NULL DEFAULT false,
  "contactable" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "assignedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommitteeAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommitteeAssignment_memberId_committeeRoleId_key"
  ON "CommitteeAssignment"("memberId", "committeeRoleId");
CREATE INDEX IF NOT EXISTS "CommitteeAssignment_committeeRoleId_idx"
  ON "CommitteeAssignment"("committeeRoleId");
CREATE INDEX IF NOT EXISTS "CommitteeAssignment_memberId_idx"
  ON "CommitteeAssignment"("memberId");
CREATE INDEX IF NOT EXISTS "CommitteeAssignment_isActive_published_sortOrder_idx"
  ON "CommitteeAssignment"("isActive", "published", "sortOrder");
CREATE INDEX IF NOT EXISTS "CommitteeAssignment_assignedByMemberId_idx"
  ON "CommitteeAssignment"("assignedByMemberId");

ALTER TABLE "CommitteeAssignment"
  ADD CONSTRAINT "CommitteeAssignment_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommitteeAssignment"
  ADD CONSTRAINT "CommitteeAssignment_committeeRoleId_fkey"
  FOREIGN KEY ("committeeRoleId") REFERENCES "CommitteeRole"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommitteeAssignment"
  ADD CONSTRAINT "CommitteeAssignment_assignedByMemberId_fkey"
  FOREIGN KEY ("assignedByMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

WITH legacy_roles AS (
  SELECT
    min(NULLIF(trim(cm."contactKey"), '')) AS contact_key,
    lower(regexp_replace(trim(cm."role"), '[^a-zA-Z0-9]+', '-', 'g')) AS base_key,
    trim(cm."role") AS name,
    min(cm."description") AS description,
    min(cm."sortOrder") AS sort_order
  FROM "CommitteeMember" cm
  WHERE trim(cm."role") <> ''
  GROUP BY trim(cm."role")
),
deduped_roles AS (
  SELECT
    COALESCE(
      contact_key,
      CASE
        WHEN base_key = '' THEN 'legacy-' || md5(name)
        ELSE base_key || '-' || left(md5(name), 8)
      END
    ) AS key,
    name,
    description,
    sort_order
  FROM legacy_roles
)
INSERT INTO "CommitteeRole" (
  "id",
  "key",
  "name",
  "description",
  "isActive",
  "sortOrder",
  "updatedAt"
)
SELECT
  'seed-committee-role-' || key,
  key,
  name,
  description,
  true,
  sort_order,
  CURRENT_TIMESTAMP
FROM deduped_roles
ON CONFLICT ("key") DO NOTHING;

WITH exact_email_matches AS (
  SELECT
    cm."id" AS committee_member_id,
    m."id" AS member_id,
    cr."id" AS role_id,
    cm."description" AS blurb,
    cm."sortOrder" AS sort_order
  FROM "CommitteeMember" cm
  JOIN "Member" m
    ON lower(m."email") = lower(cm."email")
  JOIN "CommitteeRole" cr
    ON cr."key" = COALESCE(
      NULLIF(trim(cm."contactKey"), ''),
      CASE
        WHEN lower(regexp_replace(trim(cm."role"), '[^a-zA-Z0-9]+', '-', 'g')) = ''
          THEN 'legacy-' || md5(trim(cm."role"))
        ELSE lower(regexp_replace(trim(cm."role"), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(md5(trim(cm."role")), 8)
      END
    )
  WHERE cm."email" IS NOT NULL
)
INSERT INTO "CommitteeAssignment" (
  "id",
  "memberId",
  "committeeRoleId",
  "blurb",
  "sortOrder",
  "published",
  "showPhone",
  "contactable",
  "isActive",
  "updatedAt"
)
SELECT
  'committee-assignment-' || md5(member_id || ':' || role_id),
  member_id,
  role_id,
  blurb,
  sort_order,
  false,
  false,
  false,
  true,
  CURRENT_TIMESTAMP
FROM exact_email_matches
ON CONFLICT ("memberId", "committeeRoleId") DO NOTHING;
