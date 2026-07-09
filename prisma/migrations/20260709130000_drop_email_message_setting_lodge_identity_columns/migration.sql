-- Contract migration: drop the value-dead EmailMessageSetting lodge-identity columns.
--
-- `lodgeName`, `lodgeTravelNote`, and `doorCode` backed the legacy singleton
-- source of email lodge identity. THIS release refactors identity resolution so
-- email always reads lodge name/travel note/door code from the `Lodge` table
-- (the explicit booking lodge, else the club's default lodge), and retires
-- `syncSoleActiveLodgeIdentity` — the helper that kept these three columns
-- mirrored on single-active-lodge installs. The app logic no longer reads their
-- VALUES, so this drop is value-dead after the same-release refactor. Single-
-- release disposition per the 20260708220100 / 20260708220200 / 20260708220300
-- precedent.
--
-- Backfill first so no admin-entered value is lost. On a legacy install the
-- singleton may hold a travel note / door code while the default lodge's own
-- columns are still NULL; copy them across before the drop. `lodgeName` is
-- deliberately NOT backfilled: `Lodge.name` is NOT NULL and authoritative, so a
-- divergent email-only lodge name is superseded by design.
--
-- Blue/green caveat: the columns stayed in the Prisma model until this same
-- release and Prisma emits explicit column lists, so the previously-deployed
-- colour's client still names lodgeName/lodgeTravelNote/doorCode in its default
-- SELECT/RETURNING on the singleton. Between migrate and cutover: member-facing
-- email sends DEGRADE but do not fail (loadPersistedEmailMessageSettings catches
-- the error and falls back to config defaults, and per-booking lodge identity
-- already reads from Lodge on that colour), while the admin email-settings
-- GET/PUT and the lodge-admin create/update routes (whose transactions call the
-- retired sync upsert) error with column-does-not-exist until cutover — admin-
-- only, brief, retryable. Deploy only with the ALLOW_BREAKING override and old
-- traffic idle or routed to the new runtime — see
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv for the full record.

-- Backfill the default lodge's travelNote/doorCode from the singleton where the
-- Lodge values are NULL. default_lodge_id() (created 20260708001100, replaced by
-- 20260709120000 which this migration sorts after) resolves the same default
-- lodge as the app's getDefaultLodgeId and resolveLodgeIdentity: the isDefault
-- flag first, else oldest active, else oldest. Touches at most one Lodge row.
UPDATE "Lodge" l
SET "travelNote" = COALESCE(l."travelNote", s."lodgeTravelNote"),
    "doorCode"   = COALESCE(l."doorCode",   s."doorCode")
FROM "EmailMessageSetting" s
WHERE s."id" = 'default'
  AND l."id" = default_lodge_id()
  AND (l."travelNote" IS NULL OR l."doorCode" IS NULL);

-- AlterTable
ALTER TABLE "EmailMessageSetting" DROP COLUMN "lodgeName",
DROP COLUMN "lodgeTravelNote",
DROP COLUMN "doorCode";
