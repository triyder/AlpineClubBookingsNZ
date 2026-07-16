-- DB-first club identity (E3 #1929). Create the admin-editable singleton table
-- only. SQL cannot read config/club.json, so no seed values are written here:
-- an empty/absent row is fully functional via the runtime fallback chain
-- (DB -> club.json -> hard default) in src/lib/club-identity-settings.ts.
-- prisma/seed.ts create-only upserts the club.json values for fresh installs;
-- it never overwrites an admin edit.
--
-- Additive, blue/green-safe: a brand-new cold config table with all-nullable
-- fields. No hot-table or breaking-SQL matches, so no BLUE_GREEN_MIGRATION_SAFETY
-- ledger row is required.

CREATE TABLE "ClubIdentitySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "shortName" TEXT,
    "hutLeaderLabel" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClubIdentitySettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClubIdentitySettings_updatedByMemberId_idx" ON "ClubIdentitySettings"("updatedByMemberId");
