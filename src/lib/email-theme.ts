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
 * To keep that background cache from lagging behind a colour-scheme change, two
 * explicit warm points call `primeEmailPalette()` (an unconditional, awaited
 * refresh): the server-boot instrumentation hook and the Site Style save API.
 * The boot prime means the first email after a cold start uses the stored theme,
 * and the save prime means an admin's colour change reaches emails immediately
 * rather than after the TTL lapses (#1912). A monotonic write token orders the
 * two writers so an older background refresh (mid-flight when the save primes)
 * cannot resolve late and clobber the freshly primed palette.
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
// Monotonic token bumped at the START of every palette read (background refresh
// or explicit prime). A read captures the token before its DB read and only
// commits its result if it still holds the latest token afterwards. This makes
// the last-STARTED read win: a slow read cannot overwrite a palette written by
// a read that started later. In particular, a stale in-flight background
// refresh (reading the OLD theme) can no longer clobber a save-time prime that
// started later and already wrote the NEW theme (#1912).
let latestWriteToken = 0;

async function refreshEmailPalette(): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  // Stamp the time up-front so a burst of renders triggers only one refresh.
  cachedAt = Date.now();
  const token = ++latestWriteToken;
  try {
    const { values } = await getWebsiteThemeRenderState();
    // Only commit if no newer read (refresh or prime) started while we were
    // reading; otherwise this result is stale and must not clobber it.
    if (token === latestWriteToken) {
      cached = toEmailPalette(values);
    }
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

/**
 * Await an unconditional refresh of the email palette from the persisted Site
 * Style theme. Unlike the TTL-gated background refresh `emailPalette()` uses,
 * this always reads the current theme and updates the cache, so an explicit warm
 * point sees the latest colours immediately:
 *   - server boot (instrumentation), so the first email uses the stored theme
 *     rather than the built-in default;
 *   - a Site Style save (admin API), so a colour-scheme change reaches emails
 *     right away instead of only after the TTL lapses (#1912);
 *   - tests, so assertions see the loaded palette.
 * Never throws — a read failure keeps the last-good/default palette. It does not
 * consult the `refreshing` guard, so a save-time prime cannot be silently
 * skipped by an in-flight background refresh. It also cannot be silently
 * CLOBBERED by one: via the shared `latestWriteToken`, an older background
 * refresh that resolves after this prime started will not overwrite the palette
 * this prime wrote, so a save/boot prime's colours stick until a later read.
 */
export async function primeEmailPalette(): Promise<void> {
  const token = ++latestWriteToken;
  try {
    const { values } = await getWebsiteThemeRenderState();
    // Only commit if no newer read started while we were reading (last-started
    // read wins), so an older in-flight background refresh cannot clobber us.
    if (token === latestWriteToken) {
      cached = toEmailPalette(values);
      cachedAt = Date.now();
    }
  } catch {
    // Keep the last-good/default palette; never throw from priming.
  }
}

/** Test hook: reset the module-level cache to its initial cold state. */
export function __resetEmailPaletteCacheForTests(): void {
  cached = DEFAULT_EMAIL_PALETTE;
  cachedAt = 0;
  refreshing = false;
  latestWriteToken = 0;
}
