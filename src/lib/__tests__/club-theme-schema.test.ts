import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUB_THEME_VALUES,
  buildClubThemeCss,
  contrastRatio,
  getBlockingContrastWarnings,
  getContrastWarnings,
  isValidLogoDataUrl,
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
