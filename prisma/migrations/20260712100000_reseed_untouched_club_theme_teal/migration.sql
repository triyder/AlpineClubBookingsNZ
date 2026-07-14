-- #1832: converge only the untouched, incomplete generic sage theme on the
-- current generic teal defaults. The earlier #1244 migration has already
-- changed the original #7a8f6a brandGold to #8fa87c, so the guard deliberately
-- matches the state produced by the complete migration history.
--
-- This is an idempotent, data-only repair. Completed themes, partially edited
-- themes, Tokoroa themes, and non-default rows do not match every predicate and
-- remain unchanged. Old and new app colours can render either palette.
UPDATE "ClubTheme"
SET
    "brandGold" = '#57b3ab',
    "brandCharcoal" = '#21362b',
    "brandDeep" = '#17231c',
    "brandRidge" = '#5c6f66',
    "brandMist" = '#d4ddd7',
    "brandSnow" = '#f5f8f6',
    "brandSafety" = '#b04d28'
WHERE "id" = 'default'
  AND "completedAt" IS NULL
  AND "brandGold" = '#8fa87c'
  AND "brandCharcoal" = '#30343b'
  AND "brandDeep" = '#1f2933'
  AND "brandRidge" = '#65717b'
  AND "brandMist" = '#d7dde1'
  AND "brandSnow" = '#f8faf8'
  AND "brandSafety" = '#c2562c'
  AND "headingFontKey" = 'LEAGUE_SPARTAN'::"ClubThemeFont"
  AND "bodyFontKey" = 'INTER'::"ClubThemeFont"
  AND "logoDataUrl" IS NULL
  AND "rawCss" = '';
