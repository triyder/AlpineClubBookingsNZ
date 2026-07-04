/**
 * Palette source for HTML email templates.
 *
 * Emails derive their brand colours from the club (Site Style) theme so they
 * match the live site. The templates in `email-templates.ts` are synchronous
 * and are rendered from ~10 `email/*` modules with no single send choke-point,
 * so instead of threading an async palette through every template we keep a
 * self-warming, module-level cache: `emailPalette()` returns the last-known
 * palette immediately and refreshes it in the background when the TTL lapses.
 *
 * The fallback is the SITE default theme (not the legacy hard-coded email
 * gold), so a cold process or a DB read failure still renders emails that look
 * like the site. Colours are consumed as-is with one guard: Site Style accepts
 * hex OR oklch(), but email clients cannot render oklch, so any non-hex role
 * value falls back to the site-default hex for that slot (see `hexOrDefault`).
 * We do no contrast logic (already enforced at theme-save, #1151) and no
 * oklch->hex conversion — just a per-role hex fallback.
 */

import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";

export interface EmailPalette {
  gold: string;
  charcoal: string;
  deep: string;
  mist: string;
  snow: string;
  ridge: string;
}

const HEX_COLOUR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function isHexColour(value: string): boolean {
  return HEX_COLOUR.test(value);
}

// Site Style accepts hex OR oklch() colours, but email clients cannot render
// oklch. Use the theme value only when it is hex; otherwise fall back to the
// site-default hex for that role so the palette is ALWAYS all-hex and emails
// can never emit oklch(). This is a fallback, not an oklch->hex conversion.
function hexOrDefault(value: string, fallback: string): string {
  return isHexColour(value) ? value : fallback;
}

/** Map normalised club-theme values -> the email palette roles (hex-guarded). */
function toEmailPalette(v: {
  brandGold: string;
  brandCharcoal: string;
  brandDeep: string;
  brandMist: string;
  brandSnow: string;
  brandRidge: string;
}): EmailPalette {
  const d = DEFAULT_CLUB_THEME_VALUES;
  return {
    gold: hexOrDefault(v.brandGold, d.brandGold),
    charcoal: hexOrDefault(v.brandCharcoal, d.brandCharcoal),
    deep: hexOrDefault(v.brandDeep, d.brandDeep),
    mist: hexOrDefault(v.brandMist, d.brandMist),
    snow: hexOrDefault(v.brandSnow, d.brandSnow),
    ridge: hexOrDefault(v.brandRidge, d.brandRidge),
  };
}

// Fallback = the SITE default theme (NOT the legacy hard-coded email gold), so
// emails still match the site even before the first refresh or if the DB read
// fails.
const DEFAULT_EMAIL_PALETTE: EmailPalette = toEmailPalette(
  DEFAULT_CLUB_THEME_VALUES
);

const TTL_MS = 5 * 60 * 1000;

let cached: EmailPalette = DEFAULT_EMAIL_PALETTE;
let cachedAt = 0;
let refreshing = false;

async function refreshEmailPalette(): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  // Stamp the time up-front so a burst of renders triggers only one refresh.
  cachedAt = Date.now();
  try {
    const { values } = await getWebsiteThemeRenderState();
    cached = toEmailPalette(values);
  } catch {
    // Keep the last-good/default palette; never throw from a background refresh.
  } finally {
    refreshing = false;
  }
}

/**
 * Synchronous palette accessor used by the email templates. Returns the cached
 * palette immediately and self-warms in the background when the TTL lapses, so
 * the first render after a cold start uses the default palette until the cache
 * warms (acceptable for a cosmetic theme).
 */
export function emailPalette(): EmailPalette {
  if (Date.now() - cachedAt > TTL_MS) {
    void refreshEmailPalette();
  }
  return cached;
}

/** Test hook: await a synchronous refresh so assertions see the loaded palette. */
export async function primeEmailPalette(): Promise<void> {
  await refreshEmailPalette();
}

/** Test hook: reset the module-level cache to its initial cold state. */
export function __resetEmailPaletteCacheForTests(): void {
  cached = DEFAULT_EMAIL_PALETTE;
  cachedAt = 0;
  refreshing = false;
}
