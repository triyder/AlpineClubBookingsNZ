-- No-outage NOT NULL for the entity tables' lodgeId (docs/multi-lodge/contract-release.md).
--
-- A default_lodge_id() column DEFAULT means an old (pre-lodge) app colour serving
-- during a blue/green cutover — whose INSERTs omit lodgeId — auto-fills the default
-- lodge, so no null is ever written and the NOT NULL holds throughout the deploy
-- (no outage, no migration abort). The default is kept permanently: harmless, since
-- new code always stamps lodgeId explicitly and it only ever fires for an old
-- colour's omitted-column writes during a cutover.
--
-- NOTE: this passes the blue/green validator override-free. The validator
-- recognises a SET NOT NULL paired with a same-column non-NULL SET DEFAULT (its
-- "Reviewed no-outage NOT NULL" exemption branch) as old_code_compatible, so the
-- deploy gate accepts it WITHOUT ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS — see the
-- BLUE_GREEN_MIGRATION_SAFETY ledger entry. An operator must NOT set that override
-- for this migration.

-- Resolve the club's default lodge (mirrors getDefaultLodgeId: oldest active, else
-- oldest). STABLE: same result within a statement; safe as a column default.
CREATE OR REPLACE FUNCTION default_lodge_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      (SELECT id FROM "Lodge" WHERE active = true ORDER BY "createdAt" ASC, id ASC LIMIT 1),
      (SELECT id FROM "Lodge" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
    )
  $$;

ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "LodgeRoom" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;

ALTER TABLE "Locker" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "Locker" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "Locker" ALTER COLUMN "lodgeId" SET NOT NULL;

ALTER TABLE "Season" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "Season" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "Season" ALTER COLUMN "lodgeId" SET NOT NULL;

ALTER TABLE "ChoreTemplate" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "ChoreTemplate" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "ChoreTemplate" ALTER COLUMN "lodgeId" SET NOT NULL;

ALTER TABLE "HutLeaderAssignment" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "HutLeaderAssignment" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "HutLeaderAssignment" ALTER COLUMN "lodgeId" SET NOT NULL;

-- Booking is the hot table; column already fully populated (expand backfill +
-- every writer stamps lodgeId), so SET NOT NULL is a validation scan, not a rewrite.
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "Booking" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET NOT NULL;
