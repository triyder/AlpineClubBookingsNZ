import { describe, expect, it } from "vitest";
import {
  AA_TEXT_CONTRAST_RATIO,
  CLUB_THEME_COLOUR_FIELDS,
  DEFAULT_CLUB_THEME_VALUES,
  TOKOROA_CLUB_THEME_VALUES,
  buildClubThemeAppCss,
  buildClubThemeCss,
  contrastRatio,
  deriveAppMutedForeground,
  getBlockingContrastWarnings,
  getContrastWarnings,
  isValidLogoDataUrl,
  isValidThemeColour,
  sanitiseRawCss,
} from "@/lib/club-theme-schema";
import { clubThemeUpdateSchema } from "@/lib/club-theme-update-schema";

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
    const warnings = getContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#ffffff",
      brandSnow: "#ffffff",
    });

    expect(contrastRatio("#000000", "#ffffff")?.toFixed(2)).toBe("21.00");
    expect(warnings.some((warning) => warning.id === "body-on-snow")).toBe(
      true,
    );
  });
});

describe("getBlockingContrastWarnings", () => {
  it("passes the shipped default palette (first-run setup is not blocked)", () => {
    expect(getBlockingContrastWarnings(DEFAULT_CLUB_THEME_VALUES)).toEqual([]);
  });

  it("blocks a measurable sub-AA pair", () => {
    // brand-charcoal button text on a near-identical gold is unreadable.
    const blocking = getBlockingContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "#33373e",
      brandCharcoal: "#30343b",
    });

    expect(blocking.some((warning) => warning.id === "button-on-gold")).toBe(
      true,
    );
    expect(
      blocking.every(
        (warning) => warning.ratio !== null && warning.ratio < 4.5,
      ),
    ).toBe(true);
  });

  it("pins every editable brand contrast pair, including the dark app accent", () => {
    const failing = {
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "#333333",
      brandCharcoal: "#303030",
      brandDeep: "#343434",
      brandMist: "#353535",
      brandSnow: "#353535",
    };

    expect(getContrastWarnings(failing).map((warning) => warning.id)).toEqual([
      "body-on-snow",
      "header-on-charcoal",
      "button-on-gold",
      "app-accent-on-deep",
      "app-accent-on-snow",
      "app-muted-on-snow",
      "app-secondary-on-mist",
    ]);
  });

  it("blocks an app accent that is unreadable on dark app chrome", () => {
    const blocking = getBlockingContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "#30343b",
      brandDeep: "#33373e",
    });

    expect(blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app-accent-on-deep" }),
      ]),
    );
  });

  it("blocks the contrast-safe light app accent and muted roles when their neutrals drift", () => {
    const blocking = getBlockingContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandCharcoal: "#f4f4f4",
      brandDeep: "#f3f3f3",
      brandSnow: "#f5f5f5",
    });

    expect(blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app-accent-on-snow" }),
        expect.objectContaining({ id: "app-muted-on-snow" }),
      ]),
    );
  });

  it("blocks secondary app text when brand mist collapses onto brand deep", () => {
    const blocking = getBlockingContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandMist: DEFAULT_CLUB_THEME_VALUES.brandDeep,
    });

    expect(blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app-secondary-on-mist" }),
      ]),
    );
  });

  it("keeps both shipped render palettes inside every contrast gate", () => {
    expect(getBlockingContrastWarnings(DEFAULT_CLUB_THEME_VALUES)).toEqual([]);
    expect(getBlockingContrastWarnings(TOKOROA_CLUB_THEME_VALUES)).toEqual([]);
  });

  it("shows why independently safe endpoints must not be interpolated for app text surfaces", () => {
    // Deep sits between black snow and white mist. Both configured endpoint
    // pairs clear AA, while their sRGB midpoint collapses almost onto deep.
    // Direct token endpoints are therefore part of the rendering contract.
    const endpointCrossingPalette = {
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#767676",
      brandSnow: "#000000",
      brandMist: "#ffffff",
      brandCharcoal: "#ffffff",
      brandGold: "#000000",
    };

    expect(getBlockingContrastWarnings(endpointCrossingPalette)).toEqual([]);
    expect(contrastRatio("#767676", "#808080") ?? 21).toBeLessThan(4.5);
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

  it("measures oklch() colours and blocks a low-contrast oklch pair", () => {
    // The site-style value field accepts oklch, so it must be enforced too.
    const blocking = getBlockingContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "oklch(0.6 0.1 140)",
      brandCharcoal: "oklch(0.58 0.09 140)",
    });

    const buttonWarning = blocking.find(
      (warning) => warning.id === "button-on-gold",
    );
    expect(buttonWarning).toBeDefined();
    expect(buttonWarning?.ratio).not.toBeNull();
    expect(buttonWarning?.ratio ?? 0).toBeLessThan(4.5);
  });

  it("allows an accessible oklch pair", () => {
    expect(
      getBlockingContrastWarnings({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "oklch(0.9 0.05 140)",
        brandCharcoal: "oklch(0.25 0.02 250)",
      }),
    ).toEqual([]);
  });
});

// #2145 — `--muted-foreground` inside `.app-theme-scope` used to be
// `var(--brand-deep)` in light and `var(--brand-snow)` in dark: byte-identical
// to `--foreground`, so the `muted` semantic role was inert and every
// `text-muted-foreground` label rendered as primary text.
describe("deriveAppMutedForeground (#2145)", () => {
  // Which surface each mode's muted text can actually land on. The brand tokens
  // come straight from the `.app-theme-scope` blocks in globals.css; the four
  // `*-muted` panel fills come from `:root` / `.dark` and are #1808-curated, so
  // they do NOT move with the brand palette even though the derived tone does —
  // which is exactly why they have to be checked. `app-theme-layout-contract`
  // pins these literals against globals.css.
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
  const lightSurfaces = (theme: typeof DEFAULT_CLUB_THEME_VALUES) => [
    theme.brandSnow, // --background / --card / --popover
    theme.brandMist, // --muted / --secondary / --accent
    ...SEMANTIC_MUTED_LIGHT,
  ];
  const darkSurfaces = (theme: typeof DEFAULT_CLUB_THEME_VALUES) => [
    theme.brandDeep, // --background
    theme.brandCharcoal, // --card / --popover / --muted / --secondary / --accent
    ...SEMANTIC_MUTED_DARK,
  ];

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["Tokoroa", TOKOROA_CLUB_THEME_VALUES],
  ])(
    "gives the %s palette a muted tone that is DISTINCT from --foreground",
    (_label, theme) => {
      const muted = deriveAppMutedForeground(theme);

      // The whole point of the issue: the role must not alias --foreground.
      expect(muted.light.toLowerCase()).not.toBe(theme.brandDeep.toLowerCase());
      expect(muted.dark.toLowerCase()).not.toBe(theme.brandSnow.toLowerCase());
      // …but it must still read as TEXT, not as a disabled state. Both shipped
      // palettes stay well clear of the 4.5:1 floor on their base surface.
      expect(contrastRatio(muted.light, theme.brandSnow) ?? 0).toBeGreaterThan(
        5,
      );
      expect(contrastRatio(muted.dark, theme.brandDeep) ?? 0).toBeGreaterThan(5);
    },
  );

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["Tokoroa", TOKOROA_CLUB_THEME_VALUES],
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
  // 0.75 is chosen with evidence, not taste: the shipped palettes land at
  // 0.41/0.53 (default light/dark) and 0.51/0.59 (Tokoroa), so the bar has real
  // headroom, while a 0.90 mix weight already reads 0.74-0.83 and a 0.99 weight
  // reads ~0.98. It is asserted only for palettes with headroom — a palette the
  // clamp walks all the way back to `--foreground` is the documented accessible
  // outcome and legitimately has a fraction of 1.
  const MUTED_STEP_CEILING = 0.75;

  it.each([
    ["default", DEFAULT_CLUB_THEME_VALUES],
    ["Tokoroa", TOKOROA_CLUB_THEME_VALUES],
  ])(
    "keeps the %s palette's muted tone a real step below --foreground, not a token one",
    (_label, theme) => {
      const muted = deriveAppMutedForeground(theme);

      for (const [tone, foreground, base] of [
        [muted.light, theme.brandDeep, theme.brandSnow],
        [muted.dark, theme.brandSnow, theme.brandDeep],
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
    // The guard's claim is universal, so this sweeps a wide grid of neutral
    // ramps rather than trusting the two shipped ones. Only palettes that pass
    // the SAVE GATE are in scope — a palette the gate rejects can never reach
    // the stylesheet, and the derivation cannot invent contrast the brand
    // colours do not have (see the endpoint-crossing case below).
    //
    // The assertion is stated RELATIVE to `--foreground`, which is the actual
    // guarantee, and it is TWO-BRANCH: it clears 4.5:1 wherever `--foreground`
    // does, and where `--foreground` itself fails AA on a listed surface it is
    // no worse than `--foreground` there. It is NOT a parity claim — the muted
    // tone is deliberately less readable than the token it softens (the
    // MUTED_STEP_CEILING test above is what enforces that it stays so).
    // An absolute "always AA" claim would be
    // false and for a reason that has nothing to do with #2145 — the curated
    // `*-muted` fills are #1808-fixed, so a palette can pick a `--brand-snow`
    // that fails AA on a warning panel all by itself. The derivation must not
    // make that worse; it cannot make it better.
    const ramp = ["#000000", "#17231c", "#4d4d46", "#767676", "#a8b0ac", "#d4ddd7", "#f5f8f6", "#ffffff"];
    let gated = 0;
    let inheritedFailures = 0;

    for (const brandDeep of ramp) {
      for (const brandSnow of ramp) {
        for (const brandMist of ramp) {
          for (const brandCharcoal of ramp) {
            const theme = {
              ...DEFAULT_CLUB_THEME_VALUES,
              brandDeep,
              brandSnow,
              brandMist,
              brandCharcoal,
            };
            if (getBlockingContrastWarnings(theme).length > 0) {
              continue;
            }
            gated += 1;
            const muted = deriveAppMutedForeground(theme);
            for (const [mode, tone, foreground, surfaces] of [
              ["light", muted.light, brandDeep, lightSurfaces(theme)],
              ["dark", muted.dark, brandSnow, darkSurfaces(theme)],
            ] as const) {
              for (const surface of surfaces) {
                const foregroundRatio = contrastRatio(foreground, surface) ?? 0;
                const mutedRatio = contrastRatio(tone, surface) ?? 0;
                const where = `${mode} ${tone} on ${surface} (deep ${brandDeep}, snow ${brandSnow}, mist ${brandMist}, charcoal ${brandCharcoal})`;

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
    }

    // Guards against the sweep silently gating everything out and passing
    // vacuously, and against the relative form passing only because the
    // `--foreground` branch never fires.
    expect(gated).toBeGreaterThan(20);
    expect(inheritedFailures).toBeGreaterThan(0);
  });

  // The curated `*-muted` panel fills are FIXED (#1808 keeps them out of
  // `app-theme-scope`) while the derived tone slides with the brand ramp — the
  // one pairing that can drift apart with nothing watching. A brand-only clamp
  // ships a sub-AA muted tone on a `bg-warning-muted` / `bg-info-muted` panel
  // for a palette that passes the save gate, on surfaces where `--foreground`
  // itself is perfectly readable. Both palettes below are gate-passing, and both
  // keep a distinct muted tone after the clamp — so this is a genuine fix, not
  // the derivation giving up and returning `--foreground`.
  it.each([
    [
      "dark",
      {
        brandDeep: "#000000",
        brandSnow: "#a8b0ac",
        brandMist: "#767676",
        brandCharcoal: "#2f2f2b",
      },
      "oklch(0.33 0.05 75)", // --warning-muted, dark
    ],
    [
      "light",
      {
        brandDeep: "#2f2f2b",
        brandSnow: "#f5f8f6",
        brandMist: "#f5f8f6",
        brandCharcoal: "#17231c",
      },
      "#dbeafe", // --info-muted, light
    ],
  ])(
    "clears AA on the curated %s semantic panel fills, which do not track the brand palette",
    (mode, neutrals, panelFill) => {
      const theme = { ...DEFAULT_CLUB_THEME_VALUES, ...neutrals };
      expect(getBlockingContrastWarnings(theme)).toEqual([]);

      const muted = deriveAppMutedForeground(theme);
      const tone = mode === "dark" ? muted.dark : muted.light;
      const foreground =
        mode === "dark" ? theme.brandSnow : theme.brandDeep;

      // `--foreground` reads fine on this panel, so a muted tone that does not
      // is a regression introduced by the derivation, not a palette problem.
      expect(contrastRatio(foreground, panelFill) ?? 0).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST_RATIO,
      );
      expect(contrastRatio(tone, panelFill) ?? 0).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST_RATIO,
      );
      // …and the clamp solved it by stepping back, not by collapsing the role.
      expect(tone.toLowerCase()).not.toBe(foreground.toLowerCase());
    },
  );

  it("degrades to --foreground rather than ship a sub-AA tone", () => {
    // The endpoint-crossing palette already pinned above: brandDeep sits BETWEEN
    // brandSnow and brandMist, so ANY move toward one surface is a move away
    // from the other. It passes the save gate, so the derivation must handle it
    // — by walking the mix all the way back and accepting that this palette
    // simply has no room for a distinct muted tone.
    const endpointCrossingPalette = {
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#767676",
      brandSnow: "#000000",
      brandMist: "#ffffff",
      brandCharcoal: "#ffffff",
      brandGold: "#000000",
    };
    expect(getBlockingContrastWarnings(endpointCrossingPalette)).toEqual([]);

    const muted = deriveAppMutedForeground(endpointCrossingPalette);

    expect(muted.light).toBe(endpointCrossingPalette.brandDeep);
    // Having collapsed onto `--foreground`, the tone is by construction exactly
    // as readable as `--foreground` on every surface — including the curated
    // `*-muted` fills, where this palette's own `--brand-deep` only manages
    // 4.23:1. That shortfall is the palette's (an #1808 gap the save gate does
    // not police), not something the derivation introduced.
    for (const surface of lightSurfaces(endpointCrossingPalette)) {
      expect(contrastRatio(muted.light, surface)).toBe(
        contrastRatio(endpointCrossingPalette.brandDeep, surface),
      );
    }
  });

  it("derives a measurable colour from oklch brand values", () => {
    // The site-style value field accepts oklch, so the derivation cannot assume
    // hex. The emitted tone is always a resolved hex, which is what makes it
    // measurable by the same gate that blocks a bad palette.
    const muted = deriveAppMutedForeground({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "oklch(0.2 0.03 150)",
      brandSnow: "oklch(0.98 0.01 150)",
      brandMist: "oklch(0.88 0.02 150)",
    });

    expect(muted.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      contrastRatio(muted.light, "oklch(0.88 0.02 150)") ?? 0,
    ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST_RATIO);
  });

  it("emits only schema-valid colours, so the injected CSS cannot be a vector", () => {
    // The derived tones are interpolated into a <style> element, so they must be
    // as constrained as the sanitised brand fields they come from.
    const muted = deriveAppMutedForeground({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "red; } body { display: none",
      brandSnow: "javascript:alert(1)",
    });

    expect(isValidThemeColour(muted.light)).toBe(true);
    expect(isValidThemeColour(muted.dark)).toBe(true);
  });

  it("injects both derived tones into the app stylesheet", () => {
    const appCss = buildClubThemeAppCss(DEFAULT_CLUB_THEME_VALUES);
    const muted = deriveAppMutedForeground(DEFAULT_CLUB_THEME_VALUES);

    expect(appCss).toContain(`--app-muted-foreground:${muted.light};`);
    expect(appCss).toContain(`--app-muted-foreground-dark:${muted.dark};`);
    // The public website scope keeps its own color-mix muted tone and must not
    // pick up the app-only tokens.
    expect(buildClubThemeCss(DEFAULT_CLUB_THEME_VALUES)).not.toContain(
      "--app-muted-foreground",
    );
  });
});

describe("generic public default palette (#1807)", () => {
  // The shipped default must read as generic New Zealand alpine, never as a
  // specific club. Tokoroa gold is seeded ONLY behind SEED_TOKOROA_THEME_COMPLETE
  // (TOKOROA_CLUB_THEME_VALUES); it must not leak into the public default.
  it("does not reuse any Tokoroa brand colour", () => {
    const tokoroaHexes = new Set(
      CLUB_THEME_COLOUR_FIELDS.map(
        (field) => TOKOROA_CLUB_THEME_VALUES[field.key].toLowerCase(),
      ),
    );
    for (const field of CLUB_THEME_COLOUR_FIELDS) {
      expect(tokoroaHexes.has(DEFAULT_CLUB_THEME_VALUES[field.key].toLowerCase())).toBe(
        false,
      );
    }
    // Belt-and-suspenders: the signature Tokoroa gold specifically is absent.
    expect(
      CLUB_THEME_COLOUR_FIELDS.some(
        (field) =>
          DEFAULT_CLUB_THEME_VALUES[field.key].toLowerCase() === "#ffcb05",
      ),
    ).toBe(false);
  });

  it("is a complete, distinct palette from the Tokoroa theme", () => {
    for (const field of CLUB_THEME_COLOUR_FIELDS) {
      expect(DEFAULT_CLUB_THEME_VALUES[field.key]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(DEFAULT_CLUB_THEME_VALUES[field.key]).not.toBe(
        TOKOROA_CLUB_THEME_VALUES[field.key],
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
