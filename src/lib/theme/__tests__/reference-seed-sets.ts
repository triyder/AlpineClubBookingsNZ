/*
 * FORK REFERENCE FIXTURES for the theme generator/guarantee tests only.
 *
 * Tokoroa's gold (#ffcb05) is FORK data and must NEVER appear in shipping code
 * (standing directive D15 — no Tokoroa colours in the public repo). It lives
 * here as a test-only fixture, and in the frozen phase-0 sign-off docs
 * (docs/theme/phase0/**), which the epic sign-off explicitly permitted. The
 * fork's own deployment carries this palette in its ClubTheme DB row, not in
 * library code.
 *
 * These reference palettes seed the generator golden-value tests, the guarantee
 * sweep, and the alias-map pins — the two reference seed sets the substrate was
 * signed off against. Moved VERBATIM (byte-identical values) out of
 * theme-substrate.ts (SEED_SETS) and club-theme-schema.ts
 * (TOKOROA_CLUB_THEME_VALUES) so no fork colour ships in shipping library code.
 */
import type { ThemeSeeds } from "../theme-substrate";
import type { ClubThemeValues } from "@/lib/club-theme-schema";

/** Migrated 3-seed values for the two reference palettes (D12 mapping). */
export const SEED_SETS: Record<"default" | "tokoroa", ThemeSeeds> = {
  default: { accent: "#57b3ab", neutralSource: "#17231c", support: "#b04d28" },
  tokoroa: { accent: "#ffcb05", neutralSource: "#2f2f2b", support: "#ff7c12" },
};

export const TOKOROA_CLUB_THEME_VALUES: ClubThemeValues = {
  brandGold: "#ffcb05",
  brandDeep: "#2f2f2b",
  brandSafety: "#ff7c12",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
  rawCss: "",
};
