-- Login & Security policy singleton (epic #2030, child #2033).
-- One config row (id "default"), mirroring ClubModuleSettings / ClubIdentitySettings.
-- Holds the club's password-complexity policy (min length + required character
-- classes) applied at password-SET time, plus magicLinkTtlMinutes carried here for
-- the sibling magic-link issue (#2034) to read without a further schema change.
--
-- No row is seeded: an absent row falls through to the code defaults in
-- src/lib/login-security-settings.ts (min length 12, classes off, TTL 15), so an
-- un-configured club behaves byte-identically to today's inline min(12).max(128).
--
-- Additive, blue/green-safe: a single new cold config table with no FK, no hot-table
-- or breaking-SQL change, so no BLUE_GREEN_MIGRATION_SAFETY ledger row is required.

-- CreateTable
CREATE TABLE "LoginSecuritySetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "minPasswordLength" INTEGER NOT NULL DEFAULT 12,
    "requireUppercase" BOOLEAN NOT NULL DEFAULT false,
    "requireLowercase" BOOLEAN NOT NULL DEFAULT false,
    "requireDigit" BOOLEAN NOT NULL DEFAULT false,
    "requireSymbol" BOOLEAN NOT NULL DEFAULT false,
    "magicLinkTtlMinutes" INTEGER NOT NULL DEFAULT 15,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginSecuritySetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginSecuritySetting_updatedByMemberId_idx" ON "LoginSecuritySetting"("updatedByMemberId");
