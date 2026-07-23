import { describe, expect, it } from "vitest";
import {
  AA_TEXT_CONTRAST_RATIO,
  CLUB_THEME_COLOUR_FIELDS,
  DEFAULT_CLUB_THEME_VALUES,
  buildClubThemeAppCss,
  buildClubThemeCss,
  contrastRatio,
  deriveAppMutedForeground,
  deriveBrandShims,
  getBlockingContrastWarnings,
  getContrastWarnings,
  isValidLogoDataUrl,
  isValidThemeColour,
  sanitiseRawCss,
  themeSeedsFromValues,
} from "@/lib/club-theme-schema";
import { SYNTHETIC_CLUB_THEME_VALUES } from "@/lib/theme/__tests__/reference-seed-sets";
import { clubThemeUpdateSchema } from "@/lib/club-theme-update-schema";
import {
  buildNeutralRamp,
  buildThemeSubstrate,
} from "@/lib/theme/theme-substrate";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("club theme validation", () => {
  it("rejects CSS injection colours at save time", () => {
    const parsed = clubThemeUpdateSchema.safeParse({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "#fff; background:url(https://example.test/a)",
      completeSetup: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a 6-digit hex seed and rejects oklch input (#2187 D6)", () => {
    // The wizard's native colour picker only emits hex, and the oklch paste-in
    // path is gone: the user-INPUT validator is now hex-only.
    expect(isValidThemeColour("#1a2b3c")).toBe(true);
    expect(isValidThemeColour(" #FFCB05 ")).toBe(true);
    expect(isValidThemeColour("oklch(0.6 0.1 140)")).toBe(false);
  });

  it("neutralises unsafe stored values before emitting CSS", () => {
    const css = buildClubThemeCss({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "red;--brand-deep:url(https://example.test/a)",
      headingFontKey: "INTER",
      bodyFontKey: "NOT_A_FONT",
    });

    expect(css).toContain(
      `--brand-gold:${DEFAULT_CLUB_THEME_VALUES.brandGold}`,
    );
    expect(css).toContain(":root,.website-theme{");
    expect(css).not.toContain(".app-theme-scope");
    expect(css).toContain("--font-website-body:var(--font-theme-inter)");
    expect(css).not.toContain("example.test");
    expect(css).not.toContain("NOT_A_FONT");
  });

  it("accepts capped image data URLs for logos", () => {
    expect(isValidLogoDataUrl(tinyPng)).toBe(true);
    expect(
      clubThemeUpdateSchema.safeParse({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoDataUrl: tinyPng,
      }).success,
    ).toBe(true);
  });

  it("warns rather than blocks when key contrast pairs miss AA", () => {
    // A near-white neutral-character seed derives a near-white page background,
    // so body text (the same seed) cannot clear AA on it. getContrastWarnings is
    // advisory only — it surfaces the pair but never blocks the save.
    const warnings = getContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#ffffff",
    });

    expect(contrastRatio("#000000", "#ffffff")?.toFixed(2)).toBe("21.00");
    expect(warnings.some((warning) => warning.id === "body-on-snow")).toBe(
      true,
    );
  });
});

describe("getBlockingContrastWarnings", () => {
  // The blocking gate no longer gates any save (#2187): the substrate guarantees
  // contrast by construction, so this helper is advisory-only. The one property
  // still worth pinning is that the shipped palettes carry no blocking pairs.
  it("returns no blocking warnings for the shipped default or a synthetic bright palette", () => {
    expect(getBlockingContrastWarnings(DEFAULT_CLUB_THEME_VALUES)).toEqual([]);
    expect(getBlockingContrastWarnings(SYNTHETIC_CLUB_THEME_VALUES)).toEqual([]);
  });
});

describe("deriveBrandShims (#2187)", () => {
  it("is deterministic and wires snow/charcoal to the substrate neutral ramp", () => {
    const first = deriveBrandShims(DEFAULT_CLUB_THEME_VALUES);
    const second = deriveBrandShims(DEFAULT_CLUB_THEME_VALUES);
    expect(first).toEqual(second);

    const neutral = buildThemeSubstrate(
      themeSeedsFromValues(DEFAULT_CLUB_THEME_VALUES),
      "light",
    ).neutralHex;
    // snow is the lightest neutral step, charcoal the darkest — the roles the
    // former columns played, now read straight off the substrate ramp.
    expect(first.snow).toBe(neutral[0]);
    expect(first.charcoal).toBe(neutral[11]);

    // The three real seeds pass through verbatim.
    expect(first.gold).toBe(DEFAULT_CLUB_THEME_VALUES.brandGold);
    expect(first.deep).toBe(DEFAULT_CLUB_THEME_VALUES.brandDeep);
    expect(first.safety).toBe(DEFAULT_CLUB_THEME_VALUES.brandSafety);
  });
});

// #2145 — `--muted-foreground` inside `.app-theme-scope` used to be
// `var(--brand-deep)` in light and `var(--brand-snow)` in dark: byte-identical
// to `--foreground`, so the `muted` semantic role was inert and every
// `text-muted-foreground` label rendered as primary text.
describe("deriveAppMutedForeground (#2145)", () => {
  // Which surface each mode's muted text can actually land on. The brand tokens
  // are derived from the 3 seeds (`deriveBrandShims`); the four `*-muted` panel
  // fills come from `:root` / `.dark` and are #1808-curated, so they do NOT move
  // with the brand palette even though the derived tone does — which is exactly
  // why they have to be checked. `app-theme-layout-contract` pins these literals
  // against globals.css.
  const SEMANTIC_MUTED_LIGHT = [
    "#fef9c3", // --warning-muted
    "#dbeafe", // --info-muted
    "#dcfce7", // --success-muted
    "#fee2e2", // --danger-muted
  ];
  const SEMANTIC_MUTED_DARK = [
    "oklch(0.33 0.05 75)", // --warning-muted
    "oklch(0.33 0.05 250)", // --info-muted
    "oklch(0.33 0.05 150)", // --success-muted
    "oklch(0.33 0.05 27)", // --danger-muted
  ];
  // `--accent` (#2144) is neutral-4 in each mode — one band off `--muted`/
  // `--secondary` (neutral-3 = brand-mist), read from the mode's own substrate
  // ramp. It is a real muted-text surface (`focus:bg-accent` dropdown/command
  // items) and the DARKER light band, so it is checked in its own right; mirrors
  // the shipped clamp set in `deriveAppMutedForeground`.
  const accentSurface = (
    theme: typeof DEFAULT_CLUB_THEME_VALUES,
    mode: "light" | "dark",
  ) => buildNeutralRamp(themeSeedsFromValues(theme), mode)[3];
  const lightSurfaces = (theme: typeof DEFAULT_CLUB_THEME_VALUES) => {
    const s = deriveBrandShims(theme);
    return [
      s.snow, // --background / --card / --popover
      s.mist, // --muted / --secondary
      accentSurface(theme, "light"), // --accent (neutral-4)
      ...SEMANTIC_MUTED_LIGHT,
    ];
  };
  const darkSurfaces = (theme: typeof DEFAULT_CLUB_THEME_VALUES) => {
    const s = deriveBrandShims(theme);
    return [
      s.deep, // --background
      s.charcoal, // --card / --popover / --muted / --secondary
      accentSurface(theme, "dark"), // --accent (neutral-4)
      ...SEMANTIC_MUTED_DARK,
    ];
  };

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["synthetic", SYNTHETIC_CLUB_THEME_VALUES],
  ])(
    "gives the %s palette a muted tone that is DISTINCT from --foreground",
    (_label, theme) => {
      const muted = deriveAppMutedForeground(theme);
      const s = deriveBrandShims(theme);

      // The whole point of the issue: the role must not alias --foreground.
      expect(muted.light.toLowerCase()).not.toBe(s.deep.toLowerCase());
      expect(muted.dark.toLowerCase()).not.toBe(s.snow.toLowerCase());
      // …but it must still read as TEXT, not as a disabled state. Both shipped
      // palettes stay well clear of the 4.5:1 floor on their base surface.
      expect(contrastRatio(muted.light, s.snow) ?? 0).toBeGreaterThan(5);
      expect(contrastRatio(muted.dark, s.deep) ?? 0).toBeGreaterThan(5);
    },
  );

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["synthetic", SYNTHETIC_CLUB_THEME_VALUES],
  ])("clears WCAG AA on every %s app surface, in both modes", (_label, theme) => {
    const muted = deriveAppMutedForeground(theme);

    for (const surface of lightSurfaces(theme)) {
      expect(contrastRatio(muted.light, surface) ?? 0).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST_RATIO,
      );
    }
    for (const surface of darkSurfaces(theme)) {
      expect(contrastRatio(muted.dark, surface) ?? 0).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST_RATIO,
      );
    }
  });

  // The DISTINCT-from-`--foreground` tests above only assert `!==`, which one
  // bit of difference satisfies. Setting MUTED_FOREGROUND_TARGET_WEIGHT to 0.99
  // — a tone visually identical to `--foreground`, defeating the entire point of
  // #2145 — passes every one of them. This is the CEILING that makes the role
  // impossible to render inert again by tuning: on a palette with headroom the
  // muted tone must carry MEASURABLY less contrast than `--foreground` does on
  // the same surface, not merely a different hex.
  //
  // It is asserted only for palettes with headroom — a palette the clamp walks
  // all the way back to `--foreground` is the documented accessible outcome and
  // legitimately has a fraction of 1.
  const MUTED_STEP_CEILING = 0.75;

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["synthetic", SYNTHETIC_CLUB_THEME_VALUES],
  ])(
    "keeps the %s palette's muted tone a real step below --foreground, not a token one",
    (_label, theme) => {
      const muted = deriveAppMutedForeground(theme);
      const s = deriveBrandShims(theme);

      for (const [tone, foreground, base] of [
        [muted.light, s.deep, s.snow],
        [muted.dark, s.snow, s.deep],
      ] as const) {
        const foregroundRatio = contrastRatio(foreground, base) ?? 0;
        const mutedRatio = contrastRatio(tone, base) ?? 0;

        expect(foregroundRatio).toBeGreaterThan(AA_TEXT_CONTRAST_RATIO);
        expect(
          mutedRatio / foregroundRatio,
          `${tone} on ${base} is ${mutedRatio.toFixed(2)}:1 against --foreground's ${foregroundRatio.toFixed(2)}:1 — not a perceptible step down`,
        ).toBeLessThanOrEqual(MUTED_STEP_CEILING);
      }
    },
  );

  it("holds AA across every brand palette a club could configure", () => {
    // The guard's claim is universal, so this sweeps the 3 SEEDS a club can
    // configure rather than trusting the two shipped ones. The muted derivation
    // reads only the neutral-character seed (`brandDeep` seeds snow/mist/charcoal
    // via the substrate ramp, and is itself `--foreground`), so the accent and
    // support seeds are swept alongside it purely to prove they never perturb the
    // result. Every configurable palette is in scope: the substrate makes every
    // one renderable, so there is no save gate to filter by.
    //
    // The assertion is stated RELATIVE to `--foreground`, which is the actual
    // guarantee, and it is TWO-BRANCH: it clears 4.5:1 wherever `--foreground`
    // does, and where `--foreground` itself fails AA on a listed surface it is
    // no worse than `--foreground` there. It is NOT a parity claim — the muted
    // tone is deliberately less readable than the token it softens (the
    // MUTED_STEP_CEILING test above is what enforces that it stays so).
    // An absolute "always AA" claim would be false and for a reason that has
    // nothing to do with #2145 — the curated `*-muted` fills are #1808-fixed, so
    // a palette can pick a neutral-character seed that fails AA on a warning
    // panel all by itself. The derivation must not make that worse; it cannot
    // make it better.
    const neutralRamp = [
      "#000000",
      "#17231c",
      "#4d4d46",
      "#767676",
      "#a8b0ac",
      "#d4ddd7",
      "#f5f8f6",
      "#ffffff",
    ];
    const accentSeeds = ["#57b3ab", "#eab308"];
    const supportSeeds = ["#b04d28", "#e11d48"];
    let swept = 0;
    let inheritedFailures = 0;

    for (const brandDeep of neutralRamp) {
      for (const brandGold of accentSeeds) {
        for (const brandSafety of supportSeeds) {
          const theme = {
            ...DEFAULT_CLUB_THEME_VALUES,
            brandGold,
            brandDeep,
            brandSafety,
          };
          const s = deriveBrandShims(theme);
          swept += 1;
          const muted = deriveAppMutedForeground(theme);
          for (const [mode, tone, foreground, surfaces] of [
            ["light", muted.light, s.deep, lightSurfaces(theme)],
            ["dark", muted.dark, s.snow, darkSurfaces(theme)],
          ] as const) {
            for (const surface of surfaces) {
              const foregroundRatio = contrastRatio(foreground, surface) ?? 0;
              const mutedRatio = contrastRatio(tone, surface) ?? 0;
              const where = `${mode} ${tone} on ${surface} (deep ${brandDeep}, gold ${brandGold}, safety ${brandSafety})`;

              // Both branches of the guarantee in one bound. Math.min means:
              // where --foreground clears 4.5:1 the bar is 4.5:1 (restated
              // explicitly just below); where --foreground itself fails AA on
              // this surface the bar is --foreground's own ratio, i.e. no
              // worse than the token it softens. This is NOT a parity
              // assertion — on a palette with headroom the muted tone is
              // deliberately well BELOW --foreground.
              expect(mutedRatio, where).toBeGreaterThanOrEqual(
                Math.min(foregroundRatio, AA_TEXT_CONTRAST_RATIO),
              );
              if (foregroundRatio >= AA_TEXT_CONTRAST_RATIO) {
                // …and clears AA wherever --foreground does.
                expect(mutedRatio, where).toBeGreaterThanOrEqual(
                  AA_TEXT_CONTRAST_RATIO,
                );
              } else {
                inheritedFailures += 1;
              }
            }
          }
        }
      }
    }

    // Guards against the sweep silently passing vacuously, and against the
    // relative form passing only because the `--foreground` branch never fires.
    expect(swept).toBeGreaterThan(20);
    expect(inheritedFailures).toBeGreaterThan(0);
  });

  it("degrades to --foreground rather than ship a sub-AA tone", () => {
    // A mid-grey neutral-character seed derives a near-white page background, so
    // the seed itself already fails AA on it. Every candidate muted tone mixes
    // TOWARD that light background — lighter still — so none can clear AA either.
    // The derivation must handle this by walking the mix all the way back and
    // accepting that this palette simply has no room for a distinct muted tone.
    const noHeadroomPalette = {
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#8f8f8f",
    };
    const s = deriveBrandShims(noHeadroomPalette);
    const muted = deriveAppMutedForeground(noHeadroomPalette);

    // Confirm the premise: the seed itself fails AA on its own page background.
    expect(contrastRatio(s.deep, s.snow) ?? 21).toBeLessThan(
      AA_TEXT_CONTRAST_RATIO,
    );

    // Having no room, the tone collapses onto `--foreground`.
    expect(muted.light).toBe(s.deep);
    // …and is therefore, by construction, exactly as readable as `--foreground`
    // on every surface — no better, no worse.
    for (const surface of lightSurfaces(noHeadroomPalette)) {
      expect(contrastRatio(muted.light, surface)).toBe(
        contrastRatio(s.deep, surface),
      );
    }
  });

  it("emits only schema-valid colours, so the injected CSS cannot be a vector", () => {
    // The derived tones are interpolated into a <style> element, so they must be
    // as constrained as the sanitised brand seeds they come from. Unsafe seeds
    // are normalised away before derivation.
    const muted = deriveAppMutedForeground({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "red; } body { display: none",
      brandSafety: "javascript:alert(1)",
    });

    expect(isValidThemeColour(muted.light)).toBe(true);
    expect(isValidThemeColour(muted.dark)).toBe(true);
  });

  it("builds app brand CSS without raw or semantic overrides", () => {
    const appCss = buildClubThemeAppCss({
      ...DEFAULT_CLUB_THEME_VALUES,
      rawCss:
        ".app-theme-scope{--success:red;--warning:red;--info:red;--danger:red}",
    });

    expect(appCss).toContain(".app-theme-scope{");
    expect(appCss).toContain(
      `--brand-gold:${DEFAULT_CLUB_THEME_VALUES.brandGold}`,
    );
    expect(appCss).not.toMatch(/--(?:success|warning|info|danger)/);
  });

  it("injects both derived tones into the app stylesheet", () => {
    const appCss = buildClubThemeAppCss(DEFAULT_CLUB_THEME_VALUES);
    const muted = deriveAppMutedForeground(DEFAULT_CLUB_THEME_VALUES);

    expect(appCss).toContain(`--app-muted-foreground:${muted.light};`);
    expect(appCss).toContain(`--app-muted-foreground-dark:${muted.dark};`);
    // The public website scope resolves its muted tone from the substrate
    // (`--muted-foreground` = neutral-11, #2217) and must not pick up the
    // app-only measured tokens.
    expect(buildClubThemeCss(DEFAULT_CLUB_THEME_VALUES)).not.toContain(
      "--app-muted-foreground",
    );
  });
});

describe("generic public default palette (#1807)", () => {
  // The shipped default must read as generic New Zealand alpine, never as a
  // specific club. No fork brand palette ships in the public repo (#2190 D15) —
  // the default must not coincide with the synthetic bright reference palette,
  // and, as a standing regression guard, must never be the founding fork's
  // signature gold. The comparison is over the 3 SEED columns
  // (`CLUB_THEME_COLOUR_FIELDS`) — there are no orphan columns left to compare.
  it("does not reuse the synthetic reference palette's colours", () => {
    const referenceHexes = new Set(
      CLUB_THEME_COLOUR_FIELDS.map(
        (field) => SYNTHETIC_CLUB_THEME_VALUES[field.key].toLowerCase(),
      ),
    );
    for (const field of CLUB_THEME_COLOUR_FIELDS) {
      expect(referenceHexes.has(DEFAULT_CLUB_THEME_VALUES[field.key].toLowerCase())).toBe(
        false,
      );
    }
    // Standing regression guard: the founding fork's signature gold must never
    // re-enter the public default (this asserts its ABSENCE — the hex itself
    // lives nowhere else in the repo).
    expect(
      CLUB_THEME_COLOUR_FIELDS.some(
        (field) =>
          DEFAULT_CLUB_THEME_VALUES[field.key].toLowerCase() === "#ffcb05",
      ),
    ).toBe(false);
  });

  it("is a complete, distinct set of seeds from the synthetic reference palette", () => {
    for (const field of CLUB_THEME_COLOUR_FIELDS) {
      expect(DEFAULT_CLUB_THEME_VALUES[field.key]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(DEFAULT_CLUB_THEME_VALUES[field.key]).not.toBe(
        SYNTHETIC_CLUB_THEME_VALUES[field.key],
      );
    }
  });
});

describe("contrastRatio oklch support", () => {
  it("measures oklch luminance (white on black is 21:1)", () => {
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")?.toFixed(2)).toBe(
      "21.00",
    );
  });

  it("agrees with the hex path for the same colour (sRGB red)", () => {
    // #ff0000 ≈ oklch(0.628 0.2577 29.23); same colour ⇒ ratio ≈ 1.
    const ratio = contrastRatio("#ff0000", "oklch(0.628 0.2577 29.23)");
    expect(ratio).not.toBeNull();
    expect(Math.abs((ratio ?? 0) - 1)).toBeLessThan(0.02);
  });
});

describe("sanitiseRawCss", () => {
  it("strips </style> breakout sequences (case-insensitive)", () => {
    expect(
      sanitiseRawCss("body{color:red}</style><meta http-equiv=refresh>"),
    ).toBe("body{color:red}<meta http-equiv=refresh>");
    expect(sanitiseRawCss("a{}</STYLE><script>evil()</script>")).toBe(
      "a{}<script>evil()</script>",
    );
    // Attributes before the > are also consumed
    expect(sanitiseRawCss("a{}</style \n>b{}")).toBe("a{}b{}");
  });

  it("leaves valid CSS unchanged", () => {
    const css = "body{font-size:16px}h1{color:var(--brand-gold)}";
    expect(sanitiseRawCss(css)).toBe(css);
  });

  it("is applied by buildClubThemeCss so the output never contains </style", () => {
    const css = buildClubThemeCss({
      ...DEFAULT_CLUB_THEME_VALUES,
      rawCss:
        "body{color:red}</style><meta http-equiv=refresh content='0;url=https://evil.test'>",
    });
    // The breakout sequence itself must be gone — the remaining content is
    // still inside the <style> element and treated as invalid CSS, not HTML.
    expect(css).not.toContain("</style");
  });

  it("is applied by clubThemeUpdateSchema so stored values are pre-sanitised", () => {
    const result = clubThemeUpdateSchema.safeParse({
      ...DEFAULT_CLUB_THEME_VALUES,
      rawCss: ".x{color:red}</STYLE><img src=x onerror=alert(1)>",
    });
    expect(result.success).toBe(true);
    expect(result.data?.rawCss).not.toContain("</");
  });
});
