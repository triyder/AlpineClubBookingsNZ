-- #2187 epic #2181 P4 — CONTRACT (destructive; the drain half of the
-- expand→runtime→contract sequence P1 opened).
--
-- Background. The club theme dropped from seven hand-picked brand colours to
-- THREE seeds (brandGold, brandDeep, brandSafety) that feed the vendored Radix
-- generator for the full 12-step substrate. The four former columns
-- (brandCharcoal/brandRidge/brandMist/brandSnow) became DEAD TO CODE at P1: new
-- code derives those surfaces from the substrate at render time
-- (deriveBrandShims) and never reads or writes them.
--
-- previous_expand_release. The EXPAND half is
-- 20260722140000_expand_club_theme_orphan_column_defaults (#2187 P1), which
-- added a DB DEFAULT to each of the four columns so new code can INSERT a
-- ClubTheme row without naming them, while pre-#2187 code (which still wrote
-- explicit values) kept rendering unchanged. That release is named in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv as this contract's previous_expand_release.
--
-- Why this is old-code compatible now. Dropping a column is only blue/green
-- safe when the draining previous colour emits NO SQL naming it — and Prisma
-- names EVERY scalar of a model in an unnarrowed find*'s SELECT and in a
-- mutation's implicit RETURNING. The P1+ runtime is the deployed/draining
-- colour and it cannot name these columns: the ClubThemeValues type carries no
-- charcoal/ridge/mist/snow field, so normaliseThemeValues / the site-style
-- write paths never set them, and no read projects them (grep-proven at HEAD:
-- brandCharcoal/brandRidge/brandMist/brandSnow appear in src/ nowhere but this
-- migration series and the schema — re-proven in P4). The DROP is therefore
-- legal only once P1 is the deployed/draining colour: DO NOT run it before the
-- P1 substrate release has shipped and soaked.
--
-- Data safety. Zero resolvable data loss: the four surfaces are derived at
-- render time from the neutral ramp, so nothing reads these stored values. On
-- rollback (git revert) the render is fully restored from the seeds with no data
-- touched; the dropped stored hexes were inert.
--
-- Lock impact. ClubTheme is a cold, admin-only, single-row config table absent
-- from HOT_TABLE_SQL_REGEX. Each DROP COLUMN is a metadata-only catalog change
-- (no table rewrite, no row-validation scan) taking a brief ACCESS EXCLUSIVE
-- lock. No index, constraint, trigger, FK, backfill DML, session-clock write, or
-- provider call is involved. Run in the normal deploy window with
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 and a BLUE_GREEN_MIGRATION_OVERRIDE_REASON
-- recording the P1 soak, and let the deploy guard stop on lock timeout.
ALTER TABLE "ClubTheme"
  DROP COLUMN "brandCharcoal",
  DROP COLUMN "brandRidge",
  DROP COLUMN "brandMist",
  DROP COLUMN "brandSnow";
