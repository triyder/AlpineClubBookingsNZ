/*
 * Fixed-seed kiosk token set (#2189 P3, epic #2181 A5/J4).
 *
 * The kiosk / wall-display surfaces are the deliberately literalist, glare-proof,
 * NON-brand-following exception (plan-lock A5). Unlike every club-themed surface,
 * the kiosk does NOT follow the club accent and does NOT vary by light/dark mode:
 * it is authored ONCE from a FIXED kiosk seed (pinned in P1 as
 * `PINS.kiosk` — near-black background `#0a0a0b`, neutral grey seed `#808080`,
 * accent `#7dd3fc`) and renders identically on every club and in either mode.
 *
 * This module derives that fixed token set from the shipping substrate:
 *  - NEUTRAL surfaces + text tiers and the ACCENT action colour come straight
 *    from `buildKioskTheme()` (the A5 dark-only kiosk substrate);
 *  - the STATUS hues (danger / success / warning / orange) are generated in the
 *    SAME fixed kiosk context (kiosk graySeed + kiosk near-black background,
 *    dark appearance), so the status tints sit correctly on the near-black page
 *    and are themselves club-independent.
 *
 * Because the values are static and mode-invariant, `globals.css` carries them as
 * literal `--kiosk-*` custom properties (a standalone, mode-agnostic block) plus
 * the `@theme` `--color-kiosk-*` utilities. `kiosk-token-contract.test.ts` pins
 * every literal against `buildKioskTokens()` (P1's fallback-pin pattern), so the
 * CSS and this derivation can never drift.
 */
import {
  PINS,
  buildKioskTheme,
  a4SolidForeground,
  oklch,
  fromOklch,
} from "./theme-substrate";
import { generateRadixColors } from "./generate-radix-colors";

/** A1 banding, replicated from theme-substrate (the export is module-private). */
const BAND_STEPS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 10, 11]);
function bandScale(hex12: string[], bandL: number[]): string[] {
  return hex12.map((hex, i) => {
    if (!BAND_STEPS.has(i)) return hex;
    const [, C, H] = oklch(hex);
    return fromOklch(bandL[i], C, H);
  });
}

/**
 * A status scale generated in the fixed kiosk context (dark, kiosk graySeed +
 * near-black background), A1-banded to the kiosk neutral ramp — the same
 * treatment `buildKioskTheme` gives the kiosk accent.
 */
function kioskStatusScale(seed: string, bandL: number[]): string[] {
  const c = generateRadixColors({
    appearance: "dark",
    accent: seed,
    gray: PINS.kiosk.graySeed,
    background: PINS.kiosk.background,
  });
  return bandScale(c.accentScale, bandL);
}

/**
 * The full fixed kiosk token map (token name without the `--kiosk-` prefix →
 * hex). Deterministic, pure, club- and mode-independent.
 */
export function buildKioskTokens(): Record<string, string> {
  const { theme, lightNeutral12 } = buildKioskTheme();
  const n = theme.neutralHex; // 12-step kiosk neutral ramp (dark)
  const a = theme.scales.accent.hex; // 12-step kiosk accent ramp (dark)
  const accentOnSolid = theme.scales.accent.generatorContrast ?? "#ffffff";
  const bandL = theme.bandL;

  const danger = kioskStatusScale(PINS.semanticSeeds.danger, bandL);
  const success = kioskStatusScale(PINS.semanticSeeds.success, bandL);
  const warning = kioskStatusScale(PINS.semanticSeeds.warning, bandL);
  const orange = kioskStatusScale(PINS.categoricalSeeds.cat4, bandL);

  const statusTriplet = (scale: string[], prefix: string) => ({
    [`${prefix}-bg`]: scale[2], // step 3 — dark tinted background
    [`${prefix}-fg`]: scale[10], // step 11 — light accent text (AA on bg + page)
    [`${prefix}-border`]: scale[6], // step 7 — visible border
  });

  const statusSolid = (scale: string[], prefix: string) => ({
    [`${prefix}-solid`]: scale[8], // step 9 — solid fill
    [`${prefix}-solid-fg`]: a4SolidForeground(
      scale[8],
      // step-9 fill has no generatorContrast here (accent-only field); recompute.
      "#ffffff",
      lightNeutral12,
    ).pick,
  });

  // Interactive states for a text-bearing status SOLID button. A `/90` opacity
  // modifier would composite the fill toward the near-black page and DARKEN it,
  // dropping a dark on-solid label below AA on hover. Instead these LIGHTEN the
  // step-9 fill by a fixed OKLCH lightness step (chroma/hue held), mirroring the
  // intent of the accent-hover/accent-active pair — so a dark label only GAINS
  // contrast when hovered/pressed. (The scale's own step 10 runs darker here, so
  // it cannot serve; a derived lighten is deterministic and monotonic.)
  const lighten = (hex: string, dL: number) => {
    const [L, C, H] = oklch(hex);
    return fromOklch(Math.min(1, L + dL), C, H);
  };
  const statusSolidStates = (scale: string[], prefix: string) => ({
    [`${prefix}-solid-hover`]: lighten(scale[8], 0.06),
    [`${prefix}-solid-active`]: lighten(scale[8], 0.12),
  });

  return {
    // --- Neutral surfaces (page darkest → chip lightest) + hover/borders. ---
    page: PINS.kiosk.background, // A5 fixed near-black page background
    card: n[2], // step 3
    inset: n[3], // step 4
    chip: n[5], // step 6
    hover: n[6], // step 7 — hover/active feedback surface
    border: n[6], // step 7 — visible rules
    "border-muted": n[3], // step 4 — faint/disabled borders

    // --- Text tiers. ---
    fg: n[11], // step 12 — primary text (near-white)
    "muted-fg": n[10], // step 11 — secondary labels
    "faint-fg": n[8], // step 9 — disabled / tertiary text

    // --- Fixed accent (the kiosk action colour; #7dd3fc seed, NOT brand). ---
    accent: a[8], // step 9 — solid fill / text / ring
    "accent-hover": a[9], // step 10
    "accent-active": a[10], // step 11
    "accent-fg": accentOnSolid, // on-accent text (generator on-solid pick)
    "accent-bg": a[2], // step 3 — tinted selected/active background
    "accent-border": a[6], // step 7 — selected/active border

    // --- Status hues (generated in the fixed kiosk context). ---
    ...statusTriplet(danger, "danger"),
    ...statusSolid(danger, "danger"),
    ...statusTriplet(success, "success"),
    ...statusSolid(success, "success"),
    ...statusSolidStates(success, "success"),
    ...statusTriplet(warning, "warning"),
    ...statusSolid(warning, "warning"),
    ...statusTriplet(orange, "orange"),
  };
}

/** Emission order for the `--kiosk-*` block + `@theme` entries (stable). */
export const KIOSK_TOKEN_ORDER = [
  "page",
  "card",
  "inset",
  "chip",
  "hover",
  "border",
  "border-muted",
  "fg",
  "muted-fg",
  "faint-fg",
  "accent",
  "accent-hover",
  "accent-active",
  "accent-fg",
  "accent-bg",
  "accent-border",
  "danger-bg",
  "danger-fg",
  "danger-border",
  "danger-solid",
  "danger-solid-fg",
  "success-bg",
  "success-fg",
  "success-border",
  "success-solid",
  "success-solid-fg",
  "success-solid-hover",
  "success-solid-active",
  "warning-bg",
  "warning-fg",
  "warning-border",
  "warning-solid",
  "warning-solid-fg",
  "orange-bg",
  "orange-fg",
  "orange-border",
] as const;
