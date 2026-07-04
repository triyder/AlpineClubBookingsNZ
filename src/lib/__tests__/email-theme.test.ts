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
} from "../email-theme";
import { welcomeTemplate } from "../email-templates";
import { DEFAULT_CLUB_THEME_VALUES } from "../club-theme-schema";

// Distinctive hex values that cannot be confused with any default palette entry.
const CUSTOM_THEME_VALUES = {
  brandGold: "#123456",
  brandCharcoal: "#654321",
  brandDeep: "#0a0b0c",
  brandRidge: "#334455",
  brandMist: "#abcdef",
  brandSnow: "#fedcba",
};

// The legacy hard-coded email gold that emails must no longer fall back to.
const LEGACY_EMAIL_GOLD = "#ffcb05";

describe("email-theme palette cache", () => {
  beforeEach(() => {
    __resetEmailPaletteCacheForTests();
    mocks.getWebsiteThemeRenderState.mockReset();
  });

  it("maps club-theme values to the email palette roles after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: CUSTOM_THEME_VALUES,
    });

    await primeEmailPalette();

    expect(emailPalette()).toEqual({
      gold: "#123456",
      charcoal: "#654321",
      deep: "#0a0b0c",
      mist: "#abcdef",
      snow: "#fedcba",
      ridge: "#334455",
    });
  });

  it("renders templates with the custom club-theme colours after priming", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: CUSTOM_THEME_VALUES,
    });

    await primeEmailPalette();

    const html = welcomeTemplate("Jo");
    // Header bar (charcoal) + accent/button (gold) prove the theme drives the email.
    expect(html).toContain("#654321");
    expect(html).toContain("#123456");
    // The default gold must not leak through when a custom theme is loaded.
    expect(html).not.toContain(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
  });

  it("falls back to the site-default hex when a role value is oklch (emails never emit oklch)", async () => {
    // Site Style accepts oklch, but email clients cannot render it: the two
    // oklch roles must fall back to their site-default hex, while the hex roles
    // are kept.
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      values: {
        brandGold: "oklch(0.7 0.1 120)",
        brandCharcoal: "#654321",
        brandDeep: "oklch(0.2 0.02 250)",
        brandRidge: "#334455",
        brandMist: "#abcdef",
        brandSnow: "#fedcba",
      },
    });

    await primeEmailPalette();

    const palette = emailPalette();
    // oklch roles -> site-default hex
    expect(palette.gold).toBe(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(palette.gold).toBe("#8fa87c");
    expect(palette.deep).toBe(DEFAULT_CLUB_THEME_VALUES.brandDeep);
    // hex roles -> kept as-is
    expect(palette.charcoal).toBe("#654321");
    expect(palette.mist).toBe("#abcdef");

    const html = welcomeTemplate("Jo");
    expect(html).toContain("#8fa87c"); // default gold substituted into the email
    expect(html).toContain("#654321"); // custom hex charcoal preserved
    expect(html).not.toContain("oklch");
  });

  it("falls back to the SITE default palette on a cold cache (no legacy gold)", () => {
    // No prime: the synchronous first read returns the default palette while the
    // background refresh warms the cache (the cold-start behaviour).
    const palette = emailPalette();

    expect(palette).toEqual({
      gold: DEFAULT_CLUB_THEME_VALUES.brandGold,
      charcoal: DEFAULT_CLUB_THEME_VALUES.brandCharcoal,
      deep: DEFAULT_CLUB_THEME_VALUES.brandDeep,
      mist: DEFAULT_CLUB_THEME_VALUES.brandMist,
      snow: DEFAULT_CLUB_THEME_VALUES.brandSnow,
      ridge: DEFAULT_CLUB_THEME_VALUES.brandRidge,
    });
    // The site default gold is #8fa87c, not the legacy email gold #ffcb05.
    expect(palette.gold).toBe("#8fa87c");
    expect(palette.gold).not.toBe(LEGACY_EMAIL_GOLD);

    const html = welcomeTemplate("Jo");
    expect(html).toContain("#8fa87c");
    expect(html).not.toContain(LEGACY_EMAIL_GOLD);
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
