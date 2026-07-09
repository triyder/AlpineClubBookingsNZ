-- #1656 / #1627 option (b): durable default-lodge resolution.
--
-- Replaces the earliest-createdAt ordering in getDefaultLodgeId() and the
-- default_lodge_id() SQL function with an explicit Lodge."isDefault" flag. The
-- createdAt ordering silently inverted on non-UTC databases (#1627): a lodge
-- created within the seed's TZ-skew window sorted before the seeded lodge and
-- became the club default. A pinned slug is not a durable alternative — the
-- seed renames the migration placeholder (slug 'lodge' -> slugify(club name))
-- and the admin rename route regenerates the slug from the name, so no slug is
-- stable enough to pin resolution to.
--
-- All-expand, blue/green-safe: a constant-default ADD COLUMN is metadata-only
-- on PostgreSQL 11+ (no table rewrite), and Lodge is a tiny, cold config table.
-- No hot-table or breaking-SQL regex matches, so no BLUE_GREEN_MIGRATION_SAFETY
-- ledger row is required.

ALTER TABLE "Lodge" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the single current default so every existing caller keeps identical
-- behaviour in today's data. The chosen lodge mirrors the PREVIOUS resolution
-- exactly (oldest active, else oldest of any state). This is only correct
-- because the #1633 TZ repair (20260708220000) runs first and has already
-- un-skewed the seeded lodge's createdAt, so "oldest active" now names the
-- genuine seeded lodge; do not reorder these migrations.
UPDATE "Lodge"
SET "isDefault" = true
WHERE "id" = (
  SELECT COALESCE(
    (SELECT id FROM "Lodge" WHERE active = true ORDER BY "createdAt" ASC, id ASC LIMIT 1),
    (SELECT id FROM "Lodge" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
  )
);

-- At most one default lodge. Partial unique index (Prisma cannot express a
-- WHERE-filtered unique in-schema; prisma migrate diff tolerates raw partial
-- indexes — same pattern as Member_email_login_unique and
-- XeroSyncOperation_active_correlationKey_unique). Changing the default must
-- unset the old row and set the new one in one transaction to avoid a
-- transient two-default state tripping this index.
CREATE UNIQUE INDEX "Lodge_isDefault_key" ON "Lodge" ("isDefault") WHERE "isDefault";

-- Resolve the club's default lodge from the flag first, then fall back to the
-- old ordering only if nothing is flagged (defence in depth; the backfill above
-- always flags one row on installs that have any lodge). STABLE: same result
-- within a statement, safe as the column DEFAULT the entity tables carry.
--
-- MIRROR CONTRACT: this must stay byte-identical in resolution to
-- getDefaultLodgeId() in src/lib/lodges.ts (isDefault first, then oldest active,
-- then oldest of any state). Any change to one side must ship a paired change to
-- the other, or a blue/green cutover could stamp different lodges from the two
-- code paths.
CREATE OR REPLACE FUNCTION default_lodge_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      (SELECT id FROM "Lodge" WHERE "isDefault" = true LIMIT 1),
      (SELECT id FROM "Lodge" WHERE active = true ORDER BY "createdAt" ASC, id ASC LIMIT 1),
      (SELECT id FROM "Lodge" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
    )
  $$;
