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

/** Distinguishing-only categorical scales (#2188 P2). These are the generated
 *  cat1..cat5 12-step scales exposed as utilities in `globals.css` (completing
 *  the plan-lock "numbered steps stay exposed" clause). They REPLACE the legacy
 *  ad-hoc `--hue-*` accent pairs as the categorical chip vocabulary: sibling
 *  column values that carry no severity (booking/payment sub-states, audit
 *  categories) reach a distinct, theme-following hue through cat1..cat5. */
export type CategoricalScale = "cat1" | "cat2" | "cat3" | "cat4" | "cat5";

/** Legacy distinguishing-only accent hues (#156). Retained only while a consumer
 *  still needs them — `teal` backs WAITLIST_OFFERED + the audit `family` badge
 *  (the brand-accent teal that must NOT follow the club accent). The remaining
 *  hues are superseded by cat1..cat5 and retire in P4 once nothing consumes them. */
export type AccentHue =
  | "orange"
  | "teal"
  | "indigo"
  | "purple"
  | "emerald";

/** Every tone a chip can render. */
export type ChipTone = SemanticTone | CategoricalScale | AccentHue;

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
//  #2188 P2 — the semantic and categorical tones now render on the generated
//  12-step scales via the signed-off chip pattern `bg-<scale>-3 text-<scale>-11`
//  (step-3 tint / step-11 accent text). This is the pattern P1's guarantee sweep
//  pins as G2b (`bg step-3 / text step-11` clears WCAG AA for every scale, both
//  modes), so the chips follow the club theme and stay AA by construction rather
//  than by the old curated `-muted`/accent hex pairs. `neutral` keeps the shadcn
//  role tokens (neutrals are not exposed as numbered steps). The legacy `--hue-*`
//  entries remain only for `teal` (still load-bearing) and its unretired siblings.
export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-3 text-info-11",
  success: "bg-success-3 text-success-11",
  warning: "bg-warning-3 text-warning-11",
  danger: "bg-danger-3 text-danger-11",
  cat1: "bg-cat1-3 text-cat1-11",
  cat2: "bg-cat2-3 text-cat2-11",
  cat3: "bg-cat3-3 text-cat3-11",
  cat4: "bg-cat4-3 text-cat4-11",
  cat5: "bg-cat5-3 text-cat5-11",
  orange: "bg-hue-orange-muted text-hue-orange",
  teal: "bg-hue-teal-muted text-hue-teal",
  indigo: "bg-hue-indigo-muted text-hue-indigo",
  purple: "bg-hue-purple-muted text-hue-purple",
  emerald: "bg-hue-emerald-muted text-hue-emerald",
};
