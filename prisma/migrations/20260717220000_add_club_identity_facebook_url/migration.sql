-- DB-first club identity: add the club Facebook URL (epic #1943, child C5 #1984).
-- The club name / short name / hut-leader label already live on this singleton
-- (20260717160000_add_club_identity_settings); socialLinks.facebook was the one
-- club-level identity field with NO DB column, so it collapses here as a single
-- additive nullable column. SQL cannot read config/club.json, so no value is
-- written: a null column falls through to the runtime fallback chain
-- (DB -> club.json socialLinks.facebook -> undefined) in
-- src/lib/club-identity-settings.ts. prisma/seed.ts create-only upserts the
-- club.json value on a fresh install, and the boot-time config self-heal
-- (src/lib/config-self-heal.ts) backfills the column from the effective config
-- iff it is still null — completing what this SQL migration mechanically cannot
-- on a `migrate deploy`, and never overwriting an admin edit.
--
-- Additive, blue/green-safe: a single new nullable column on a cold config table.
-- No hot-table or breaking-SQL matches, so no BLUE_GREEN_MIGRATION_SAFETY ledger
-- row is required.

ALTER TABLE "ClubIdentitySettings" ADD COLUMN "facebookUrl" TEXT;
