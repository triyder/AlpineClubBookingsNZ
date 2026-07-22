-- #2187 P1 — EXPAND (additive, non-destructive; blue/green safe).
--
-- The club theme dropped from seven hand-picked brand colours to THREE seeds
-- (brandGold, brandDeep, brandSafety), which feed the vendored Radix generator
-- for the full 12-step substrate. The four former columns
-- (brandCharcoal/brandRidge/brandMist/brandSnow) are now DEAD TO CODE: new code
-- derives those surfaces from the substrate at render time and never reads or
-- writes them.
--
-- They stay in the table so pre-#2187 code (still live during a blue/green
-- cutover) keeps rendering. The only change is a DB DEFAULT so new code can
-- INSERT a ClubTheme row without naming them; old code, which still writes
-- explicit values, is unaffected. No data is rewritten and no column is
-- dropped. The destructive CONTRACT migration that drops these columns ships in
-- P4 with a docs/BLUE_GREEN_MIGRATION_SAFETY.tsv ledger row.
ALTER TABLE "ClubTheme" ALTER COLUMN "brandCharcoal" SET DEFAULT '#21362b';
ALTER TABLE "ClubTheme" ALTER COLUMN "brandRidge" SET DEFAULT '#5c6f66';
ALTER TABLE "ClubTheme" ALTER COLUMN "brandMist" SET DEFAULT '#d4ddd7';
ALTER TABLE "ClubTheme" ALTER COLUMN "brandSnow" SET DEFAULT '#f5f8f6';
