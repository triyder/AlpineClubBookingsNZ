/*
 * Theme substrate — the shipping derivation (#2187, epic #2181 P1).
 *
 * Turns a club's THREE seed inputs (accent + neutral-character + support) into the
 * full Radix-style 12-step light/dark token substrate, via the vendored generator
 * (./generate-radix-colors.ts). This is the single source of truth the wizard
 * preview, the render-time CSS builder, the guarantee sweep, and the golden-value
 * tests all call — so a colour that survives the guarantees here is the colour that
 * ships.
 *
 * Locked Phase-0 treatment applied here (see docs/theme/phase0 + the #2181 sign-off):
 *  - A1 lightness bands on neutral steps 1–8 & 11–12 (indices 0–7,10,11); steps
 *    9–10 keep the generator's hue-faithful free lightness.
 *  - A3 derived backgrounds (never picked): light L≈0.985 C0.004, dark L≈0.20.
 *  - Neutral seed derived from the neutral-character hue: oklch(0.50, 0.008, H).
 *  - A2 input/ring is pinned to neutral-10 uniformly in the alias layer (J1); the
 *    computed pick is exposed here only for measurement/reporting.
 *  - A4 AA solid-foreground fallback: keep the generator's on-solid pick iff ≥4.5:1,
 *    else white → light-mode neutral-12 → black.
 *  - A5 fixed kiosk seed generation (dark only), reused by P3.
 *
 * Determinism: pure function of the seeds + these pins. The golden-value tests pin
 * every output hex, generated inside node:24.17-alpine (the production image).
 */
import Color from "colorjs.io";
import { generateRadixColors, type Appearance } from "./generate-radix-colors";

export interface ThemeSeeds {
  /** Primary accent (the club brand colour). */
  accent: string;
  /** Neutral character source — its hue tints the grey ramp. */
  neutralSource: string;
  /** Optional support accent. */
  support: string;
}

export interface BuiltScale {
  /** 12 banded hexes (what ships). */
  hex: string[];
  /** 12 raw generator hexes before A1 banding. */
  hexRaw: string[];
  /** 12 alpha (on-background) hexes. */
  alpha: string[];
  /** The generator's own on-solid text pick for step 9/10 (null for neutral). */
  generatorContrast: string | null;
}

export interface BuiltTheme {
  mode: Appearance;
  graySeed: string;
  background: string;
  neutralHex: string[];
  neutralAlpha: string[];
  /** A1 band-source lightness (from the neutral ramp). */
  bandL: number[];
  /** neutral + every hue scale (accent, support, 4 semantic, 5 categorical). */
  scales: Record<string, BuiltScale>;
}

// ---------------------------------------------------------------------------
// Colour helpers (WCAG 2.x on opaque sRGB — matches the wrapper + guarantees).
// ---------------------------------------------------------------------------
export const oklch = (hex: string): [number, number, number] =>
  new Color(hex).to("oklch").coords as [number, number, number];

export const fromOklch = (L: number, C: number, H: number): string =>
  new Color("oklch", [L, C, isNaN(H) ? 0 : H]).to("srgb").toString({ format: "hex" });

function relLum(hex: string): number {
  const [r, g, b] = new Color(hex).to("srgb").coords.map((c: number) => {
    c = Math.min(1, Math.max(0, c));
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG relative-luminance contrast ratio between two opaque sRGB hexes. */
export function contrast(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Pinned constants (Phase-0, signed off on #2181 2026-07-22).
// ---------------------------------------------------------------------------
export const PINS = {
  neutralSeed: { L: 0.5, C: 0.008 },
  background: { lightL: 0.985, darkL: 0.2, C: 0.004 },
  /** A1 bands snap steps 1–8 and 11–12 (indices 0..7,10,11); 9–10 untouched. */
  bandSteps: [0, 1, 2, 3, 4, 5, 6, 7, 10, 11] as readonly number[],
  semanticSeeds: {
    success: "#1f9d55",
    warning: "#e5a50a",
    info: "#2563eb",
    danger: "#dc2626",
  } as Record<string, string>,
  categoricalSeeds: {
    cat1: "#7c5cff",
    cat2: "#189ab4",
    cat3: "#d6409f",
    cat4: "#e8730c",
    cat5: "#8aa614",
    // #2218 P4 — a sixth categorical hue (teal, oklch H≈183). Chosen for MAXIMUM
    // minimum perceptual separation from cat1-5 AND the four semantic hues: its
    // step-9 sits ΔE2000 ≈ 17.6 (hue ≥ 31°) from every existing cat/semantic
    // step-9 tone (the widest min-ΔE of the measured candidates), in the
    // green(152°)-cyan(216°) gap. It gives the booking column its needed 6th
    // distinguisher (WAITLIST_OFFERED), retiring the last --hue-* pair.
    cat6: "#14b8a6",
  } as Record<string, string>,
  /** A5 kiosk: fixed, club-independent, glare-proof high contrast. Dark only. */
  kiosk: {
    background: "#0a0a0b",
    graySeed: "#808080",
    accent: "#7dd3fc",
  },
} as const;

/** Every hue scale the substrate produces, in slot order. */
export const HUE_SCALES = [
  "accent",
  "support",
  "success",
  "warning",
  "info",
  "danger",
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "cat6",
] as const;
export type HueScaleName = (typeof HUE_SCALES)[number];

// ---------------------------------------------------------------------------
// Derivations.
// ---------------------------------------------------------------------------
export function deriveGrayAndBg(neutralSource: string): {
  graySeed: string;
  bgLight: string;
  bgDark: string;
} {
  const [, , H] = oklch(neutralSource);
  const graySeed = fromOklch(PINS.neutralSeed.L, PINS.neutralSeed.C, H);
  const bgLight = fromOklch(PINS.background.lightL, PINS.background.C, H);
  const bgDark = fromOklch(PINS.background.darkL, PINS.background.C, H);
  return { graySeed, bgLight, bgDark };
}

/** A1: snap banded steps to the neutral ramp's lightness; keep 9–10 free. */
function bandScale(hex12: string[], bandL: number[]): string[] {
  return hex12.map((hex, i) => {
    if (!PINS.bandSteps.includes(i)) return hex;
    const [, C, H] = oklch(hex);
    return fromOklch(bandL[i], C, H);
  });
}

function seedHexFor(seeds: ThemeSeeds, name: HueScaleName): string {
  if (name === "accent") return seeds.accent;
  if (name === "support") return seeds.support;
  if (PINS.semanticSeeds[name]) return PINS.semanticSeeds[name];
  if (PINS.categoricalSeeds[name]) return PINS.categoricalSeeds[name];
  throw new Error("no seed for " + name);
}

/** Build one (seeds, mode) substrate fully. */
export function buildThemeSubstrate(seeds: ThemeSeeds, mode: Appearance): BuiltTheme {
  const { graySeed, bgLight, bgDark } = deriveGrayAndBg(seeds.neutralSource);
  const bg = mode === "light" ? bgLight : bgDark;

  const neutralCall = generateRadixColors({ appearance: mode, accent: graySeed, gray: graySeed, background: bg });
  const neutralHex = neutralCall.grayScale;
  const neutralAlpha = neutralCall.grayScaleAlpha;
  const bandL = neutralHex.map((h) => oklch(h)[0]);

  const scales: Record<string, BuiltScale> = {
    neutral: { hex: neutralHex, hexRaw: neutralHex, alpha: neutralAlpha, generatorContrast: null },
  };

  for (const name of HUE_SCALES) {
    const seedHex = seedHexFor(seeds, name);
    const c = generateRadixColors({ appearance: mode, accent: seedHex, gray: graySeed, background: bg });
    scales[name] = {
      hex: bandScale(c.accentScale, bandL),
      hexRaw: c.accentScale,
      alpha: c.accentScaleAlpha,
      generatorContrast: c.accentContrast,
    };
  }

  return { mode, graySeed, background: bg, neutralHex, neutralAlpha, bandL, scales };
}

/**
 * Just the 12-step NEUTRAL ramp for a mode — byte-identical to
 * `buildThemeSubstrate(seeds, mode).neutralHex`, but without the ~11 hue-scale
 * generator calls a full build makes. Callers that need only neutral surfaces
 * (`deriveBrandShims`, the app muted-foreground clamp) run per render, so this
 * keeps that path an order of magnitude cheaper than a full substrate build.
 */
export function buildNeutralRamp(seeds: ThemeSeeds, mode: Appearance): string[] {
  const { graySeed, bgLight, bgDark } = deriveGrayAndBg(seeds.neutralSource);
  const bg = mode === "light" ? bgLight : bgDark;
  return generateRadixColors({
    appearance: mode,
    accent: graySeed,
    gray: graySeed,
    background: bg,
  }).grayScale;
}

/** A5 kiosk substrate (dark only) + its light-neutral-12 for the A4 ladder. */
export function buildKioskTheme(): { theme: BuiltTheme; lightNeutral12: string } {
  const { background, graySeed, accent } = PINS.kiosk;
  const neutralDark = generateRadixColors({ appearance: "dark", accent: graySeed, gray: graySeed, background });
  const bandL = neutralDark.grayScale.map((h) => oklch(h)[0]);
  const lightBg = fromOklch(0.985, 0.004, oklch(graySeed)[2]);
  const neutralLight = generateRadixColors({ appearance: "light", accent: graySeed, gray: graySeed, background: lightBg });
  const lightNeutral12 = neutralLight.grayScale[11];
  const c = generateRadixColors({ appearance: "dark", accent, gray: graySeed, background });
  const scales: Record<string, BuiltScale> = {
    neutral: { hex: neutralDark.grayScale, hexRaw: neutralDark.grayScale, alpha: neutralDark.grayScaleAlpha, generatorContrast: null },
    accent: { hex: bandScale(c.accentScale, bandL), hexRaw: c.accentScale, alpha: c.accentScaleAlpha, generatorContrast: c.accentContrast },
  };
  const theme: BuiltTheme = {
    mode: "dark",
    graySeed,
    background,
    neutralHex: neutralDark.grayScale,
    neutralAlpha: neutralDark.grayScaleAlpha,
    bandL,
    scales,
  };
  return { theme, lightNeutral12 };
}

export interface A4Result {
  pick: string;
  ratio: number;
  source: "generator" | "white" | "light-neutral-12" | "black" | "best-fallback";
  passAA: boolean;
}

/**
 * A4 solid-foreground recompute (R9): keep the generator's on-solid pick iff it
 * clears AA (≥4.5:1) on the fill; otherwise walk white → light-mode neutral-12 →
 * black and take the first that clears AA. If none do, return the best available
 * and flag it (passAA:false) so the guarantee sweep stops-and-reports.
 */
export function a4SolidForeground(fillHex: string, genPick: string, lightNeutral12: string): A4Result {
  const genRatio = contrast(genPick, fillHex);
  if (genRatio >= 4.5) return { pick: genPick, ratio: r2(genRatio), source: "generator", passAA: true };
  const ladder: Array<[string, A4Result["source"]]> = [
    ["#ffffff", "white"],
    [lightNeutral12, "light-neutral-12"],
    ["#000000", "black"],
  ];
  for (const [cand, source] of ladder) {
    const cr = contrast(cand, fillHex);
    if (cr >= 4.5) return { pick: cand, ratio: r2(cr), source, passAA: true };
  }
  let best = ladder[0][0];
  let bestR = contrast(best, fillHex);
  for (const [cand] of ladder) {
    const cr = contrast(cand, fillHex);
    if (cr > bestR) {
      bestR = cr;
      best = cand;
    }
  }
  return { pick: best, ratio: r2(bestR), source: "best-fallback", passAA: false };
}

/**
 * A2 measurement: first neutral step from 8 downward (idx 7..11) with contrast
 * ≥3:1 vs neutral surfaces 1–3. Exposed for reporting only — the alias layer PINS
 * --input/--ring to neutral-10 uniformly (J1), it does NOT consume this pick.
 */
export function a2ComputedPick(neutralHex: string[]): { step: number; idx: number; hex: string; min: number } | null {
  const surfaces = [neutralHex[0], neutralHex[1], neutralHex[2]];
  for (let idx = 7; idx <= 11; idx++) {
    const min = Math.min(...surfaces.map((s) => contrast(neutralHex[idx], s)));
    if (min >= 3) return { step: idx + 1, idx, hex: neutralHex[idx], min: r2(min) };
  }
  return null;
}
