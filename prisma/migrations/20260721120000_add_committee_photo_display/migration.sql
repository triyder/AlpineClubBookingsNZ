-- MP5 (#193), epic #171 — committee-roster photo display setting. EXPAND-ONLY.
--
-- Adds the CommitteePhotoDisplay enum and a PublicContentSettings.committeePhotoDisplay
-- column (NOT NULL DEFAULT 'NONE'). CREATE TYPE registers a new enum in the
-- catalog and touches no table. The ADD COLUMN carries a CONSTANT default, so it
-- is a PostgreSQL 11+ catalog-only change (no table rewrite, no row scan, brief
-- ACCESS EXCLUSIVE lock) on the cold single-row (id='default') PublicContentSettings
-- config table, which is not in HOT_TABLE_SQL_REGEX. The default backfills the one
-- existing row to NONE (photos hidden) — a privacy-safe opt-in. No index, no
-- foreign key, no backfill DML, no provider call, no destructive SQL.
CREATE TYPE "CommitteePhotoDisplay" AS ENUM ('NONE', 'CIRCLE', 'SQUARE');

ALTER TABLE "PublicContentSettings" ADD COLUMN "committeePhotoDisplay" "CommitteePhotoDisplay" NOT NULL DEFAULT 'NONE';
