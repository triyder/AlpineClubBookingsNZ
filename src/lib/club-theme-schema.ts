export const CLUB_THEME_ID = "default";
export const MAX_LOGO_DATA_URL_BYTES = 900_000;

export const CLUB_THEME_COLOUR_FIELDS = [
  { key: "brandGold", label: "Primary accent" },
  { key: "brandCharcoal", label: "Charcoal" },
  { key: "brandDeep", label: "Deep" },
  { key: "brandRidge", label: "Ridge" },
  { key: "brandMist", label: "Mist" },
  { key: "brandSnow", label: "Snow" },
  { key: "brandSafety", label: "Safety" },
] as const;

export type ClubThemeColourKey =
  (typeof CLUB_THEME_COLOUR_FIELDS)[number]["key"];

export const CLUB_THEME_FONT_KEYS = [
  "INTER",
  "LEAGUE_SPARTAN",
  "LORA",
  "SOURCE_SERIF_4",
  "NUNITO_SANS",
  "OSWALD",
] as const;

export type ClubThemeFontKey = (typeof CLUB_THEME_FONT_KEYS)[number];

export const CLUB_THEME_FONT_OPTIONS: Array<{
  key: ClubThemeFontKey;
  label: string;
  role: "Body" | "Heading" | "Flexible";
  cssVariable: string;
}> = [
  {
    key: "INTER",
    label: "Inter",
    role: "Body",
    cssVariable: "--font-theme-inter",
  },
  {
    key: "LEAGUE_SPARTAN",
    label: "League Spartan",
    role: "Heading",
    cssVariable: "--font-theme-league-spartan",
  },
  {
    key: "LORA",
    label: "Lora",
    role: "Heading",
    cssVariable: "--font-theme-lora",
  },
  {
    key: "SOURCE_SERIF_4",
    label: "Source Serif 4",
    role: "Heading",
    cssVariable: "--font-theme-source-serif-4",
  },
  {
    key: "NUNITO_SANS",
    label: "Nunito Sans",
    role: "Flexible",
    cssVariable: "--font-theme-nunito-sans",
  },
  {
    key: "OSWALD",
    label: "Oswald",
    role: "Heading",
    cssVariable: "--font-theme-oswald",
  },
];

export type ClubThemeValues = Record<ClubThemeColourKey, string> & {
  headingFontKey: ClubThemeFontKey;
  bodyFontKey: ClubThemeFontKey;
  logoDataUrl: string | null;
  rawCss: string;
};

export const DEFAULT_CLUB_THEME_VALUES: ClubThemeValues = {
  // Generic "Aotearoa" default palette (#1807): a glacial-teal primary accent on
  // a deep bush-green cool-stone neutral ramp, with a terracotta safety accent.
  // Reads as generic New Zealand alpine, not any specific club (Tokoroa gold now
  // lives only in TOKOROA_CLUB_THEME_VALUES). brandGold is the primary-action
  // colour with brand-charcoal button text (see .website-theme
  // --primary/--primary-foreground); it must clear WCAG AA 4.5:1 against
  // brand-charcoal — teal #57b3ab on #21362b gives 5.19:1. Every gated pair
  // passes getBlockingContrastWarnings (regression-pinned in
  // club-theme-schema.test.ts).
  brandGold: "#57b3ab",
  brandCharcoal: "#21362b",
  brandDeep: "#17231c",
  brandRidge: "#5c6f66",
  brandMist: "#d4ddd7",
  brandSnow: "#f5f8f6",
  brandSafety: "#b04d28",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
  rawCss: "",
};

export const TOKOROA_CLUB_THEME_VALUES: ClubThemeValues = {
  brandGold: "#ffcb05",
  brandCharcoal: "#4d4d46",
  brandDeep: "#2f2f2b",
  brandRidge: "#6a6a63",
  brandMist: "#d9d5c2",
  brandSnow: "#f7f5ed",
  brandSafety: "#ff7c12",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
  rawCss: "",
};

const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const OKLCH_NUMBER = "(?:0|[1-9]\\d*)(?:\\.\\d{1,4})?";
const OKLCH_LIGHTNESS = `(?:${OKLCH_NUMBER}|(?:0|[1-9]\\d|100)(?:\\.\\d{1,2})?%)`;
const OKLCH_CHROMA = OKLCH_NUMBER;
const OKLCH_HUE = "(?:0|[1-9]\\d{0,2}|3[0-5]\\d|360)(?:\\.\\d{1,2})?";
const OKLCH_COLOUR_PATTERN = new RegExp(
  `^oklch\\(${OKLCH_LIGHTNESS} ${OKLCH_CHROMA} ${OKLCH_HUE}\\)$`,
  "i",
);
const LOGO_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export function isValidThemeColour(value: string): boolean {
  const trimmed = value.trim();
  return HEX_COLOUR_PATTERN.test(trimmed) || OKLCH_COLOUR_PATTERN.test(trimmed);
}

function logoDataUrlByteLength(value: string): number | null {
  const match = value.trim().match(LOGO_DATA_URL_PATTERN);
  if (!match) {
    return null;
  }

  const base64 = match[2];
  if (base64.length % 4 !== 0) {
    return null;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function isValidLogoDataUrl(value: string): boolean {
  const byteLength = logoDataUrlByteLength(value);
  return byteLength !== null && byteLength <= MAX_LOGO_DATA_URL_BYTES;
}

function fontOption(fontKey: ClubThemeFontKey) {
  return CLUB_THEME_FONT_OPTIONS.find((font) => font.key === fontKey);
}

export function fontLabel(fontKey: ClubThemeFontKey): string {
  return fontOption(fontKey)?.label ?? fontKey;
}

export function fontCssVariable(fontKey: ClubThemeFontKey): string {
  return (
    fontOption(fontKey)?.cssVariable ??
    fontOption(DEFAULT_CLUB_THEME_VALUES.bodyFontKey)?.cssVariable ??
    "--font-theme-inter"
  );
}

// test seam
// Strip any </style...> closing-tag sequence (case-insensitive). This is
// the only HTML breakout vector from inside a <style> element — browsers use
// rawtext mode and close the element on </style regardless of nesting. No
// valid CSS ever contains that sequence, so silent removal is safe and lossless.
export function sanitiseRawCss(value: string): string {
  // Match </style, then consume any non-'>' characters and the closing '>'
  // so the entire tag token is removed rather than leaving a stray '>'.
  return value.replace(/<\/style[^>]*>/gi, "");
}

function sanitiseThemeColour(
  value: unknown,
  field: ClubThemeColourKey,
): string {
  return typeof value === "string" && isValidThemeColour(value)
    ? value.trim()
    : DEFAULT_CLUB_THEME_VALUES[field];
}

function sanitiseThemeFont(value: unknown, fallback: ClubThemeFontKey) {
  return CLUB_THEME_FONT_KEYS.includes(value as ClubThemeFontKey)
    ? (value as ClubThemeFontKey)
    : fallback;
}

function sanitiseLogoDataUrl(value: unknown): string | null {
  return typeof value === "string" && isValidLogoDataUrl(value)
    ? value.trim()
    : null;
}

export function normaliseThemeValues(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): ClubThemeValues {
  return {
    brandGold: sanitiseThemeColour(value?.brandGold, "brandGold"),
    brandCharcoal: sanitiseThemeColour(value?.brandCharcoal, "brandCharcoal"),
    brandDeep: sanitiseThemeColour(value?.brandDeep, "brandDeep"),
    brandRidge: sanitiseThemeColour(value?.brandRidge, "brandRidge"),
    brandMist: sanitiseThemeColour(value?.brandMist, "brandMist"),
    brandSnow: sanitiseThemeColour(value?.brandSnow, "brandSnow"),
    brandSafety: sanitiseThemeColour(value?.brandSafety, "brandSafety"),
    headingFontKey: sanitiseThemeFont(
      value?.headingFontKey,
      DEFAULT_CLUB_THEME_VALUES.headingFontKey,
    ),
    bodyFontKey: sanitiseThemeFont(
      value?.bodyFontKey,
      DEFAULT_CLUB_THEME_VALUES.bodyFontKey,
    ),
    logoDataUrl: sanitiseLogoDataUrl(value?.logoDataUrl),
    rawCss:
      typeof value?.rawCss === "string" ? sanitiseRawCss(value.rawCss) : "",
  };
}

export function buildClubThemeCss(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): string {
  const theme = normaliseThemeValues(value);
  const base = `:root,.website-theme{${buildClubThemeDeclarations(theme)}}`;
  return theme.rawCss ? `${base}\n${theme.rawCss}` : base;
}

/** Brand/font variables for app shells. Deliberately excludes rawCss so an
 * administrator's public-site CSS cannot override app or semantic tokens.
 *
 * Also emits the two DERIVED app muted-text tones (#2145). They are computed
 * here rather than expressed as a CSS `color-mix()` for one reason: a mix is
 * unmeasurable from TypeScript, and this repository's app-scope rule is that
 * every TEXT token resolves to a solid endpoint whose contrast the gate can
 * actually measure (see `getContrastWarnings` and the endpoint-crossing case in
 * `club-theme-schema.test.ts`). Emitting a resolved colour keeps that true. */
export function buildClubThemeAppCss(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): string {
  const theme = normaliseThemeValues(value);
  const muted = deriveAppMutedForeground(theme);
  return `.app-theme-scope{${buildClubThemeDeclarations(theme)}--app-muted-foreground:${muted.light};--app-muted-foreground-dark:${muted.dark};}`;
}

function buildClubThemeDeclarations(theme: ClubThemeValues): string {
  return `--brand-gold:${theme.brandGold};--brand-charcoal:${theme.brandCharcoal};--brand-deep:${theme.brandDeep};--brand-ridge:${theme.brandRidge};--brand-mist:${theme.brandMist};--brand-snow:${theme.brandSnow};--brand-safety:${theme.brandSafety};--font-website-heading:var(${fontCssVariable(theme.headingFontKey)});--font-website-body:var(${fontCssVariable(theme.bodyFontKey)});`;
}

export type ContrastWarning = {
  id: string;
  label: string;
  ratio: number | null;
  message: string;
};

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (!HEX_COLOUR_PATTERN.test(trimmed)) {
    return null;
  }

  return {
    r: Number.parseInt(trimmed.slice(1, 3), 16),
    g: Number.parseInt(trimmed.slice(3, 5), 16),
    b: Number.parseInt(trimmed.slice(5, 7), 16),
  };
}

function channelToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// Linear sRGB for an oklch() colour. The value field on the site-style wizard
// accepts any schema-valid colour (hex or oklch), so contrast enforcement has to
// measure oklch too — otherwise an admin could paste a low-contrast oklch pair
// straight through the gate. oklch -> oklab -> linear sRGB uses Björn Ottosson's
// matrices; the linear RGB it yields is exactly what the luminance sum needs (no
// extra gamma step), clamped for out-of-gamut hues.
function oklchToLinearRgb(
  colour: string,
): { r: number; g: number; b: number } | null {
  const match = colour
    .trim()
    .match(/^oklch\(\s*([^\s]+)\s+([^\s]+)\s+([^\s)]+)\s*\)$/i);
  if (!match) {
    return null;
  }

  const lightnessToken = match[1];
  const L = lightnessToken.endsWith("%")
    ? Number.parseFloat(lightnessToken) / 100
    : Number.parseFloat(lightnessToken);
  const C = Number.parseFloat(match[2]);
  const hueDegrees = Number.parseFloat(match[3]);
  if (
    !Number.isFinite(L) ||
    !Number.isFinite(C) ||
    !Number.isFinite(hueDegrees)
  ) {
    return null;
  }

  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = C * Math.cos(hueRadians);
  const b = C * Math.sin(hueRadians);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Inverse of `channelToLinear`: linear sRGB (0..1) back to an 0..255 channel. */
function linearToChannel(value: number): number {
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp01(encoded) * 255;
}

/**
 * A schema-valid colour (hex or oklch) as gamma-encoded sRGB channels.
 *
 * The oklch path round-trips through `oklchToLinearRgb`, which CLAMPS
 * out-of-gamut hues — so an oklch colour outside sRGB resolves to its clamped
 * sRGB neighbour here. That is only used for MIXING; every contrast figure this
 * module reports is measured on the resulting colour itself, so a clamp changes
 * which tone is derived but never makes a reported ratio untrue.
 */
function colourToRgb(colour: string): { r: number; g: number; b: number } | null {
  const rgb = hexToRgb(colour);
  if (rgb) {
    return rgb;
  }

  const linear = oklchToLinearRgb(colour);
  if (!linear) {
    return null;
  }

  return {
    r: linearToChannel(linear.r),
    g: linearToChannel(linear.g),
    b: linearToChannel(linear.b),
  };
}

/**
 * `foreground` mixed toward `towards` in gamma-encoded sRGB, matching CSS
 * `color-mix(in srgb, <foreground> <weight>%, <towards>)`, as a `#rrggbb` hex.
 */
function mixSrgb(
  foreground: string,
  towards: string,
  foregroundWeight: number,
): string | null {
  const from = colourToRgb(foreground);
  const to = colourToRgb(towards);
  if (!from || !to) {
    return null;
  }

  const channel = (a: number, b: number) =>
    Math.round(a * foregroundWeight + b * (1 - foregroundWeight))
      .toString(16)
      .padStart(2, "0");

  return `#${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`;
}

function relativeLuminance(colour: string): number | null {
  const rgb = hexToRgb(colour);
  if (!rgb) {
    const linear = oklchToLinearRgb(colour);
    return linear
      ? clamp01(0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b)
      : null;
  }

  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

// test seam
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    return null;
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The WCAG AA minimum for normal-size body text. */
export const AA_TEXT_CONTRAST_RATIO = 4.5;

/**
 * Where the derived muted tone AIMS to land: 70% foreground, 30% surface. This
 * mirrors the mix `.website-theme` already uses for its own `--muted-foreground`
 * (`color-mix(in srgb, var(--brand-deep) 70%, var(--brand-snow))` in
 * `globals.css`), so the app scope follows the existing house derivation instead
 * of inventing a second one.
 */
const MUTED_FOREGROUND_TARGET_WEIGHT = 0.7;

/** How far each clamp step walks the tone back toward `--foreground`. */
const MUTED_FOREGROUND_WEIGHT_STEP = 0.02;

/**
 * The curated semantic `*-muted` surfaces, light mode, exactly as declared on
 * `:root` in `src/app/globals.css`.
 *
 * These are in the clamp set because they are REAL muted-text backgrounds
 * (`bg-warning-muted`/`bg-info-muted`/`bg-danger-muted`/`bg-success-muted`
 * panels carry `text-muted-foreground` footnotes in ~35 places across
 * bed-allocation, waitlist, committee, and family-suggestions) AND because
 * #1808 deliberately does NOT override them inside `app-theme-scope`. They are
 * therefore FIXED while the derived tone moves with the brand palette — the one
 * combination that can drift apart silently. Every other surface muted text
 * lands on is either a brand token the clamp already covers, or is remapped to
 * one in dark mode (`bg-white`/`bg-*-50` -> `--card`, `bg-*-100` -> `--muted`,
 * `hover:bg-*-50` -> `--accent`).
 *
 * Pinned against `globals.css` by `app-theme-layout-contract.test.ts` so the two
 * cannot drift.
 */
const SEMANTIC_MUTED_SURFACES_LIGHT = [
  "#fef9c3", // --warning-muted
  "#dbeafe", // --info-muted
  "#dcfce7", // --success-muted
  "#fee2e2", // --danger-muted
] as const;

/** The `.dark` half of {@link SEMANTIC_MUTED_SURFACES_LIGHT}. */
const SEMANTIC_MUTED_SURFACES_DARK = [
  "oklch(0.33 0.05 75)", // --warning-muted
  "oklch(0.33 0.05 250)", // --info-muted
  "oklch(0.33 0.05 150)", // --success-muted
  "oklch(0.33 0.05 27)", // --danger-muted
] as const;

/**
 * The brand tokens whose VALUES the light clamp checks, named as they appear in
 * `globals.css`. `--brand-snow` backs `--background`/`--card`/`--popover`;
 * `--brand-mist` backs `--muted`/`--secondary`/`--accent`.
 *
 * This list is the CONTRACT, not a convenience: `docs/ARCHITECTURE.md` publishes
 * it as "the surfaces the derived muted tone is guaranteed against", and
 * `app-theme-layout-contract.test.ts` fails if the prose and this list disagree.
 * Prose that claims a broader guarantee than the code delivers is the specific
 * failure mode this pin exists to prevent.
 */
export const APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS = [
  "--brand-snow",
  "--brand-mist",
  "--warning-muted",
  "--info-muted",
  "--success-muted",
  "--danger-muted",
] as const;

/** The dark-mode counterpart of {@link APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS}. */
export const APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS = [
  "--brand-deep",
  "--brand-charcoal",
  "--warning-muted",
  "--info-muted",
  "--success-muted",
  "--danger-muted",
] as const;

/**
 * Surfaces DELIBERATELY excluded from the clamp set.
 *
 * `--border`/`--input` are hairline tokens. Dark mode remaps `bg-*-200` onto
 * `--border`, so a `bg-slate-200` badge WOULD be a muted-text surface — but the
 * only such badge (`page-content-panel.tsx`) was moved to
 * `bg-muted text-muted-foreground` instead, because a mid-luminance rule colour
 * is the wrong background for body text at any weight. Clamping against it
 * instead would collapse the derived tone into `--foreground` for roughly 30% of
 * gate-passing palettes rather than the ~12% it does today, defeating #2145 for
 * a surface no text should sit on.
 *
 * Those two figures are like-for-like: both are measured over the 77
 * gate-passing palettes of the neutral-ramp sweep in
 * `club-theme-schema.test.ts`, counting a palette that collapses in EITHER mode
 * (11.7% today vs 29.9% with `--border` clamped, replicating the `--border`
 * mixes from `globals.css`). Per-mode the same comparison reads 5.2% -> 11.7%
 * light and 6.5% -> 24.7% dark. Every framing shows the same 2.5-3x increase;
 * quote one consistently rather than mixing a light-only figure with an
 * either-mode one.
 *
 * Kept as a value rather than a comment so the docs pin can assert the
 * exclusion is STATED, not silently assumed.
 */
export const APP_MUTED_FOREGROUND_EXCLUDED_SURFACES = ["--border", "--input"] as const;

/**
 * A muted tone for `foreground`, mixed toward `towards` and then clamped back
 * toward `foreground` until it clears WCAG AA against EVERY surface it can land
 * on.
 *
 * What this guarantees is TWO-BRANCH, and only over the LISTED surfaces: where
 * `foreground` itself clears 4.5:1 on a listed surface, the returned tone clears
 * 4.5:1 there too; where `foreground` itself FAILS AA on a listed surface (an
 * inherited failure — a curated `*-muted` fill is fixed while the brand ramp
 * moves), the returned tone is no worse than `foreground` there.
 *
 * What it does NOT guarantee is parity with `foreground`. The returned tone is
 * deliberately LESS readable than the token it softens — that is the entire
 * point of the role, and `club-theme-schema.test.ts` fails if the ratio it
 * carries ever climbs back above 0.75 of `foreground`'s on a palette with
 * headroom.
 *
 * What it does NOT guarantee: that the tone is DISTINCT from `foreground`. A
 * palette with no contrast headroom (one whose own body text only just clears
 * AA, or fails it) walks all the way back and returns `foreground` unchanged —
 * accessibility wins over the semantic distinction, and the result is exactly
 * today's behaviour rather than a regression. `getBlockingContrastWarnings`
 * is what stops such a palette being saved in the first place.
 */
function deriveMutedTone(
  foreground: string,
  towards: string,
  surfaces: readonly string[],
): string {
  for (
    let weight = MUTED_FOREGROUND_TARGET_WEIGHT;
    weight < 1;
    weight += MUTED_FOREGROUND_WEIGHT_STEP
  ) {
    const candidate = mixSrgb(foreground, towards, weight);
    if (!candidate) {
      // Neither accepted colour format parsed; fall back to the un-muted role
      // rather than emitting an unmeasured colour.
      return foreground;
    }
    const clearsAa = surfaces.every(
      (surface) =>
        (contrastRatio(candidate, surface) ?? 0) >= AA_TEXT_CONTRAST_RATIO,
    );
    if (clearsAa) {
      return candidate;
    }
  }

  return foreground;
}

export type AppMutedForegroundTones = {
  /** Value for `--muted-foreground` in the light `.app-theme-scope` block. */
  light: string;
  /** Value for `--muted-foreground` in the `.dark .app-theme-scope` block. */
  dark: string;
};

/**
 * The derived `--muted-foreground` tones for the app scope (#2145).
 *
 * Before this, `.app-theme-scope` set `--muted-foreground` to the same brand
 * colour as `--foreground`, so `text-muted-foreground` — used all over the admin
 * and finance surfaces for secondary labels and footnotes — rendered
 * identically to primary text and the `muted` semantic role was inert.
 *
 * Each mode mixes its foreground 30% toward its own base surface and then
 * clamps for AA against the SIX surfaces that mode can put muted text on —
 * `APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS` /
 * `APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS`:
 *
 * - light: `--brand-deep` toward `--brand-snow`, checked against `--brand-snow`
 *   (`--background`/`--card`/`--popover`), `--brand-mist`
 *   (`--muted`/`--secondary`/`--accent`), and the four curated light
 *   `*-muted` panel fills;
 * - dark: `--brand-snow` toward `--brand-deep`, checked against `--brand-deep`
 *   (`--background`), `--brand-charcoal`
 *   (`--card`/`--popover`/`--muted`/`--secondary`/`--accent`), and the four
 *   curated dark `*-muted` panel fills.
 *
 * Checking both BRAND surfaces per mode rather than only the base one is what
 * makes the guard hold for an ENDPOINT-CROSSING palette — one whose
 * `--brand-deep` sits BETWEEN `--brand-snow` and `--brand-mist`. Mixing toward
 * one surface moves the tone AWAY from the other, so a single-surface check
 * would ship a sub-AA muted tone for a palette that passes the save gate today
 * (the `#767676`/`#000000`/`#ffffff` case pinned in
 * `club-theme-schema.test.ts`).
 *
 * Checking the curated `*-muted` fills as well is what makes it hold for a
 * palette that MOVES while they stay put: they are excluded from the app scope
 * by #1808, so a brand ramp can slide the derived tone toward them without any
 * brand-only check noticing. See `SEMANTIC_MUTED_SURFACES_LIGHT`.
 *
 * `APP_MUTED_FOREGROUND_EXCLUDED_SURFACES` records what is deliberately NOT in
 * the set, and why.
 */
export function deriveAppMutedForeground(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): AppMutedForegroundTones {
  const theme = normaliseThemeValues(value);

  return {
    light: deriveMutedTone(theme.brandDeep, theme.brandSnow, [
      theme.brandSnow,
      theme.brandMist,
      ...SEMANTIC_MUTED_SURFACES_LIGHT,
    ]),
    dark: deriveMutedTone(theme.brandSnow, theme.brandDeep, [
      theme.brandDeep,
      theme.brandCharcoal,
      ...SEMANTIC_MUTED_SURFACES_DARK,
    ]),
  };
}

export function getContrastWarnings(
  value: Partial<Record<keyof ClubThemeValues, unknown>>,
): ContrastWarning[] {
  const theme = normaliseThemeValues(value);
  const checks: Array<{
    id: string;
    label: string;
    foreground: string;
    background: string;
  }> = [
    {
      id: "body-on-snow",
      label: "Body text on page background",
      foreground: theme.brandDeep,
      background: theme.brandSnow,
    },
    {
      id: "header-on-charcoal",
      label: "Header text on navigation background",
      foreground: theme.brandSnow,
      background: theme.brandCharcoal,
    },
    {
      id: "button-on-gold",
      label: "Button text on primary action",
      foreground: theme.brandCharcoal,
      background: theme.brandGold,
    },
    {
      id: "app-accent-on-deep",
      label: "App accent on dark app chrome",
      foreground: theme.brandGold,
      background: theme.brandDeep,
    },
    {
      id: "app-accent-on-snow",
      label: "App accent foreground on light app background",
      foreground: theme.brandCharcoal,
      background: theme.brandSnow,
    },
    {
      id: "app-muted-on-snow",
      label: "App muted text on light app background",
      foreground: theme.brandDeep,
      background: theme.brandSnow,
    },
    {
      id: "app-secondary-on-mist",
      label: "App text on secondary surface",
      foreground: theme.brandDeep,
      background: theme.brandMist,
    },
  ];

  const warnings: ContrastWarning[] = [];

  for (const check of checks) {
    const ratio = contrastRatio(check.foreground, check.background);
    if (ratio === null) {
      warnings.push({
        id: check.id,
        label: check.label,
        ratio,
        message: `${check.label}: check WCAG AA contrast manually for OKLCH colours.`,
      });
      continue;
    }
    if (ratio >= 4.5) {
      continue;
    }
    warnings.push({
      id: check.id,
      label: check.label,
      ratio,
      message: `${check.label}: ${ratio.toFixed(2)}:1 is below the WCAG AA 4.5:1 text target.`,
    });
  }

  return warnings;
}

/**
 * The subset of contrast warnings that must block a save: pairs whose ratio is
 * measurable and below the WCAG AA 4.5:1 text minimum. Both accepted colour
 * formats (hex and oklch) are measured, so this covers every value an admin can
 * enter. The ratio === null guard is a defensive fallback for a value that
 * somehow parses to neither; such a pair stays advisory rather than blocking.
 */
export function getBlockingContrastWarnings(
  value: Partial<Record<keyof ClubThemeValues, unknown>>,
): ContrastWarning[] {
  return getContrastWarnings(value).filter(
    (warning) => warning.ratio !== null && warning.ratio < 4.5,
  );
}
