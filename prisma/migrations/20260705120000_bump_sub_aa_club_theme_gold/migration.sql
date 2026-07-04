-- #1244: one-time bump of the sub-AA default gold #7a8f6a -> #8fa87c (owner-decided MIGRATE).
-- Idempotent, data-only: each UPDATE is a no-op when no ClubTheme row holds the old value, so
-- re-running the migration changes nothing. No DDL, no schema.prisma change. The old value only
-- ever entered as the lowercase #7a8f6a seed default (20260611123000_add_club_theme) and the
-- site-style contrast gate now blocks it, so an exact case-sensitive match covers every variant.
UPDATE "ClubTheme" SET "brandGold"     = '#8fa87c' WHERE "brandGold"     = '#7a8f6a';
UPDATE "ClubTheme" SET "brandCharcoal" = '#8fa87c' WHERE "brandCharcoal" = '#7a8f6a';
UPDATE "ClubTheme" SET "brandDeep"     = '#8fa87c' WHERE "brandDeep"     = '#7a8f6a';
UPDATE "ClubTheme" SET "brandRidge"    = '#8fa87c' WHERE "brandRidge"    = '#7a8f6a';
UPDATE "ClubTheme" SET "brandMist"     = '#8fa87c' WHERE "brandMist"     = '#7a8f6a';
UPDATE "ClubTheme" SET "brandSnow"     = '#8fa87c' WHERE "brandSnow"     = '#7a8f6a';
UPDATE "ClubTheme" SET "brandSafety"   = '#8fa87c' WHERE "brandSafety"   = '#7a8f6a';
