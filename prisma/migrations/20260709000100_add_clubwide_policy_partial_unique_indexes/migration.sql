-- Restore DB-level uniqueness over the club-wide (lodgeId IS NULL) partitions
-- of CancellationPolicy and LodgeInstruction (multi-lodge contract follow-up;
-- deferred item in docs/multi-lodge/contract-release.md).
--
-- PostgreSQL treats NULLs as distinct under the composite @@unique([lodgeId,
-- ...]) keys, so the club-wide partition has been app-enforced only (the
-- cancellation admin route's Serializable replace transaction and the
-- lodge-instructions route's findFirst-then-write). Prisma's schema cannot
-- express a partial index, but `prisma migrate diff` (db:check-drift) also
-- does not surface partial indexes it cannot express, so a raw-SQL index here
-- does not trip the drift gate — same precedent as Member_email_primary_unique,
-- Member_email_login_unique, and the XeroSyncOperation ACTIVE-per-correlation
-- index.
--
-- Defensive dedupe first: app enforcement should mean no duplicates exist in
-- the null partitions, but if any slipped through a lost race, keep the most
-- recently updated row (ties broken by id) so the index build cannot abort
-- the deploy. Both tables are small config tables (policy tiers, instruction
-- documents), so the delete scan and index build are brief.

-- Dedupe club-wide cancellation tiers: keep the greatest (updatedAt, id) row
-- per daysBeforeStay.
DELETE FROM "CancellationPolicy" a
USING "CancellationPolicy" b
WHERE a."lodgeId" IS NULL
  AND b."lodgeId" IS NULL
  AND a."daysBeforeStay" = b."daysBeforeStay"
  AND (a."updatedAt", a."id") < (b."updatedAt", b."id");

-- Dedupe club-wide instruction documents: keep the greatest (updatedAt, id)
-- row per key.
DELETE FROM "LodgeInstruction" a
USING "LodgeInstruction" b
WHERE a."lodgeId" IS NULL
  AND b."lodgeId" IS NULL
  AND a."key" = b."key"
  AND (a."updatedAt", a."id") < (b."updatedAt", b."id");

-- CreateIndex
CREATE UNIQUE INDEX "CancellationPolicy_clubwide_daysBeforeStay_unique"
  ON "CancellationPolicy" ("daysBeforeStay")
  WHERE "lodgeId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "LodgeInstruction_clubwide_key_unique"
  ON "LodgeInstruction" ("key")
  WHERE "lodgeId" IS NULL;
