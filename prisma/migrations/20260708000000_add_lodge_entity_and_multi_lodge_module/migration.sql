-- Phase 1 of docs/multi-lodge/implementation-plan.md: the Lodge entity and the
-- multiLodge Admin Module flag. The Lodge table is core (booking data scopes to
-- it from phase 2 onward); the module flag gates only the lodge-management
-- configuration surface (ADR-002). Constant-default ADD COLUMN is
-- metadata-only on PostgreSQL 11+.

CREATE TABLE IF NOT EXISTS "Lodge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "doorCode" VARCHAR(80),
    "travelNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lodge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Lodge_slug_key" ON "Lodge"("slug");

ALTER TABLE "ClubModuleSettings"
    ADD COLUMN IF NOT EXISTS "multiLodge" BOOLEAN NOT NULL DEFAULT false;

-- Seed exactly one lodge for deployments that have none (ADR-001 migration
-- step 1). Identity values come from the EmailMessageSetting singleton where
-- the club has configured them; the name falls back to the 'Lodge'
-- placeholder, which prisma/seed.ts upgrades to the club-config lodge name on
-- fresh installs. Existing deployments keep operating single-lodge with the
-- multiLodge module off.
INSERT INTO "Lodge" ("id", "name", "slug", "active", "doorCode", "travelNote", "createdAt", "updatedAt")
SELECT
    'lodge-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
    COALESCE(NULLIF(TRIM(ems."lodgeName"), ''), 'Lodge'),
    'lodge',
    true,
    NULLIF(TRIM(ems."doorCode"), ''),
    NULLIF(TRIM(ems."lodgeTravelNote"), ''),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (SELECT 1) AS seed
LEFT JOIN "EmailMessageSetting" ems ON ems."id" = 'default'
WHERE NOT EXISTS (SELECT 1 FROM "Lodge");
