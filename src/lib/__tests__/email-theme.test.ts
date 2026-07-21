import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebsiteThemeRenderState: vi.fn(),
}));

// Mock only the theme loader. The real `club-theme-schema` is kept so the
// fallback assertions use the genuine site default palette.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
}));

import {
  __resetEmailPaletteCacheForTests,
  emailPalette,
  primeEmailPalette,
  type EmailPalette,
} from "../email-theme";
import { passwordResetTemplate } from "../email-templates";
import {
  DEFAULT_CLUB_THEME_VALUES,
  deriveBrandShims,
  themeSeedsFromValues,
  type ClubThemeValues,
} from "../club-theme-schema";
import { buildThemeSubstrate } from "@/lib/theme/theme-substrate";

// The email palette is DERIVED from the three seeds via the light substrate
// (#2187 D7): gold/deep pass through, and charcoal/mist/snow/ridge are the
// neutral-ramp light steps (12/3/1/8). Compute the expectation the same way the
// module does, rather than hard-coding derived hexes that would silently drift
// if the generator retunes.
function expectedPalette(values: Pick<ClubThemeValues, "brandGold" | "brandDeep" | "brandSafety">): EmailPalette {
  const s = deriveBrandShims(values as ClubThemeValues);
  return {
    gold: s.gold,
    charcoal: s.charcoal,
    deep: s.deep,
    mist: s.mist,
    snow: s.snow,
    ridge: s.ridge,
  };
}

// Distinctive hex SEEDS that cannot be confused with any default palette entry.
const CUSTOM_THEME_VALUES = {
  brandGold: "#123456",
  brandDeep: "#0a0b0c",
  brandSafety: "#334455",
};

// The legacy hard-coded email gold that emails must no longer fall back to.
const LEGACY_EMAIL_GOLD = "#ffcb05";

describe("email-theme palette cache", () => {
  beforeEach(() => {
    __resetEmailPaletteCacheForTests();
    mocks.getWebsiteThemeRenderState.mockReset();
  });

  it("derives the email palette from the light substrate after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: CUSTOM_THEME_VALUES,
    });

    await primeEmailPalette();

    const palette = emailPalette();
    expect(palette).toEqual(expectedPalette(CUSTOM_THEME_VALUES));

    // D7: the neutral roles are the LIGHT-mode generated steps, not literals.
    // `snow` is neutral step 1 (index 0) of the light substrate.
    const lightSnow = buildThemeSubstrate(
      themeSeedsFromValues(CUSTOM_THEME_VALUES as ClubThemeValues),
      "light",
    ).neutralHex[0];
    expect(palette.snow).toBe(lightSnow);
    // The two direct seed roles pass through verbatim.
    expect(palette.gold).toBe("#123456");
    expect(palette.deep).toBe("#0a0b0c");
  });

  it("renders templates with the custom club-theme colours after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: CUSTOM_THEME_VALUES,
    });

    await primeEmailPalette();

    const p = expectedPalette(CUSTOM_THEME_VALUES);
    const html = passwordResetTemplate("Jo");
    // Header bar (charcoal) + accent/button (gold) prove the theme drives the email.
    expect(html).toContain(p.charcoal);
    expect(html).toContain(p.gold);
    // The default gold must not leak through when a custom theme is loaded.
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
  });

  it("falls back to the SITE default palette on a cold cache (no legacy gold)", () => {
    // No prime: the synchronous first read returns the default palette while the
    // background refresh warms the cache (the cold-start behaviour).
    const palette = emailPalette();

    expect(palette).toEqual(expectedPalette(DEFAULT_CLUB_THEME_VALUES));
    // The site default gold is #57b3ab, not the legacy email gold #ffcb05.
    expect(palette.gold).toBe(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(palette.gold).toBe("#57b3ab");
    expect(palette.gold).not.toBe(LEGACY_EMAIL_GOLD);

    const html = passwordResetTemplate("Jo");
    expect(html).toContain("#57b3ab");
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
  });

  it("reflects a colour-scheme change on the next prime so emails drop the old colours (#1912)", async () => {
    // Cache warmed with an initial custom scheme (as a running server would be).
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce({
      values: CUSTOM_THEME_VALUES,
    });
    await primeEmailPalette();
    expect(passwordResetTemplate("Jo")).toContain("#123456");

    // Admin saves a new scheme; the save path re-primes the palette.
    const NEXT_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
      brandDeep: "#202124",
    };
    mocks.getWebsiteThemeRenderState.mockResolvedValueOnce({
      values: NEXT_THEME_VALUES,
    });
    await primeEmailPalette();

    const html = passwordResetTemplate("Jo");
    expect(html).toContain("#0f9d58"); // new accent/button colour (gold seed)
    expect(html).toContain("#202124"); // new body-text colour (deep seed)
    expect(html).not.toContain("#123456"); // previous scheme's gold is gone
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
  });

  it("does not let a stale in-flight background refresh clobber a save-time prime (#1912)", async () => {
    const OLD_THEME_VALUES = CUSTOM_THEME_VALUES; // gold #123456
    const NEW_THEME_VALUES = {
      ...CUSTOM_THEME_VALUES,
      brandGold: "#0f9d58",
      brandDeep: "#202124",
    };

    // A deferred result so we control exactly when the background refresh's OLD
    // read resolves (i.e. keep it in flight while the prime lands).
    let releaseOldRefresh!: () => void;
    const oldRefreshResult = new Promise<{ values: typeof OLD_THEME_VALUES }>(
      (resolve) => {
        releaseOldRefresh = () => resolve({ values: OLD_THEME_VALUES });
      },
    );

    mocks.getWebsiteThemeRenderState
      // 1st call: the TTL-triggered background refresh reads the OLD scheme, but
      // its promise stays pending until we release it below.
      .mockReturnValueOnce(oldRefreshResult)
      // 2nd call: the save-time prime reads the NEW scheme and resolves at once.
      .mockResolvedValueOnce({ values: NEW_THEME_VALUES });

    // Cold cache (cachedAt = 0) => this trips the TTL and starts a background
    // refresh, which is now parked awaiting the deferred OLD read.
    emailPalette();

    // The admin save re-primes with the NEW scheme while the OLD refresh is
    // still in flight. The prime reads NEW and writes the cache.
    await primeEmailPalette();
    expect(emailPalette().gold).toBe("#0f9d58");

    // Now the stale background refresh finally resolves with the OLD scheme. It
    // started BEFORE the prime, so it must not overwrite the prime's palette.
    releaseOldRefresh();
    await oldRefreshResult;
    await Promise.resolve(); // flush the refresh's post-await continuation

    const html = passwordResetTemplate("Jo");
    expect(html).toContain("#0f9d58"); // NEW accent/button preserved
    expect(html).toContain("#202124"); // NEW body-text colour preserved
    expect(html).not.toContain("#123456"); // stale OLD gold did NOT clobber
    expect(emailPalette().gold).toBe("#0f9d58");
  });

  it("serves cached values within the TTL without re-hitting the loader", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: CUSTOM_THEME_VALUES,
    });

    await primeEmailPalette();
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);

    // Repeated reads inside the TTL window return the cached palette and must
    // not trigger another loader call.
    expect(emailPalette().gold).toBe("#123456");
    expect(emailPalette().gold).toBe("#123456");
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalledTimes(1);
  });
});
