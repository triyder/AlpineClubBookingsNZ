/**
 * Single source of truth for chip / pill colour classes (#156).
 *
 * The admin tables render many small status and label chips: the shared
 * `StatusChip`, the payments/bookings `MiniChip`, and the members `InfoChip`.
 * Each of those previously carried its OWN private copy of the same tone -> class
 * map, so they could silently drift. This module holds the one map they all use.
 *
 * There are two families of tone, both backed by CSS tokens in `globals.css`:
 *
 *  - SEMANTIC tones (`neutral | info | success | warning | danger`) carry MEANING
 *    and back `StatusChip`. Every pair dark-adapts and clears WCAG AA (verified
 *    in `src/lib/__tests__/status-chip.test.tsx`).
 *  - ACCENT hues (`orange | teal | indigo | purple | emerald`) exist only
 *    to keep sibling values within one column visually DISTINCT (e.g. the five
 *    payment settlement kinds, the six payment states). They harmonise with the
 *    "Restrained Alpine" palette through the `--hue-*` tokens rather than raw
 *    ad-hoc Tailwind colours.
 *
 * Meaning is always carried by icon + label, never colour alone.
 */

/** Meaning-carrying tones used by StatusChip. */
export type SemanticTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Distinguishing-only accent hues for sibling column values. */
export type AccentHue =
  | "orange"
  | "teal"
  | "indigo"
  | "purple"
  | "emerald";

/** Every tone a chip can render. */
export type ChipTone = SemanticTone | AccentHue;

/** Tone -> `bg-*-muted text-*` utility classes.
 *
 *  Neutral pairs `--foreground` with `--muted` rather than `--muted-foreground`.
 *  The original reason was that `--muted-foreground` failed AA on `--muted`;
 *  inside `app-theme-scope` that is no longer true, because #2145 replaced the
 *  inert `--muted-foreground` (an alias of `--foreground`) with a derived tone
 *  that is CLAMPED to clear AA on `--muted` in both modes. The pairing stays on
 *  `--foreground` for a different and still-valid reason: a status chip carries
 *  MEANING, so it reads at full text weight like its four coloured siblings —
 *  each of which uses its own accent, not a de-emphasised one. It also keeps the
 *  chip readable in the default (non-club-themed) shadcn scope, where
 *  `--muted-foreground` is a mid-grey this project does not gate. */
export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-muted text-info",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
  orange: "bg-hue-orange-muted text-hue-orange",
  teal: "bg-hue-teal-muted text-hue-teal",
  indigo: "bg-hue-indigo-muted text-hue-indigo",
  purple: "bg-hue-purple-muted text-hue-purple",
  emerald: "bg-hue-emerald-muted text-hue-emerald",
};
