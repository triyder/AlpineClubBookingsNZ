-- Add OSWALD value to the ClubThemeFont enum so admins can pick the Oswald
-- condensed display face for headings/body in Site Style → Fonts. Additive
-- only; existing theme rows keep their current font keys.

ALTER TYPE "ClubThemeFont" ADD VALUE IF NOT EXISTS 'OSWALD';
