-- Lodge.address (E3 #1929): admin-editable postal/physical address, feeding the
-- {{lodge-address}} content token and the public contact page's lodge block.
--
-- Behaviour-preservation backfill (footer-backfill precedent): the contact page
-- previously hardcoded "Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New
-- Zealand"; that de-Waldvogel change removes the literal from code, so the
-- historical string is written into the EXISTING default lodge here so live
-- deployments keep showing their address. This backfill lives in migration SQL
-- ONLY — prisma/seed.ts must never write it, because seed-account-defaults.test
-- (`/Iwikau|Ruapehu|Whakapapa|Tokoroa/i`) polices club geography out of seeds so
-- fresh installs get a blank address. default_lodge_id() (migration
-- 20260709120000) resolves the same default lodge as getDefaultLodgeId().
--
-- Additive, blue/green-safe: a nullable ADD COLUMN is metadata-only on
-- PostgreSQL 11+ (no table rewrite), and Lodge is a tiny cold config table; the
-- single-row UPDATE targets one config row. No hot-table or breaking-SQL
-- matches, so no BLUE_GREEN_MIGRATION_SAFETY ledger row is required.

ALTER TABLE "Lodge" ADD COLUMN "address" VARCHAR(300);

UPDATE "Lodge"
SET "address" = 'Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand'
WHERE "id" = default_lodge_id();
