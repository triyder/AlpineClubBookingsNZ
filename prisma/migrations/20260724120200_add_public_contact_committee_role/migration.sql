-- Public Contact page "Club Details" committee-role selector.
--
-- Blue/green EXPAND migration (see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv):
--  * adds ONE new nullable column to the PublicContentSettings singleton. Purely
--    additive — the previously deployed (old-colour) client selects an explicit
--    PublicContentSettings column set that does not name this column, so it keeps
--    working unchanged during migrate -> cutover drain. No column drop/alter, no
--    RENAME, no backfill DML, no foreign key, and no external provider call.
ALTER TABLE "PublicContentSettings" ADD COLUMN     "contactCommitteeRoleKey" TEXT;
