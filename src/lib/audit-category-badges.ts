import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

/**
 * Single source of truth for the audit-category badge colours (#2137).
 *
 * The member-facing `audit-timeline.tsx` and the admin `/admin/audit-log` page
 * each used to carry their OWN identical copy of this map, so the two surfaces
 * could silently drift apart. They now share this one.
 *
 * These are CATEGORICAL colours: they distinguish sibling categories in one
 * column and must stay stable across every admin-configured theme, so they do
 * not use the brand accent. The `family` row reaches its teal through the
 * `--hue-*` token system via `CHIP_TONE_CLASSES.teal` rather than a literal
 * Tailwind `teal-*` utility, so it dark-adapts with the rest of the chip
 * system; the remaining rows keep the literal Tailwind families that the
 * dark-mode colored-callout pass in `globals.css` (#1248) re-tints.
 */
export const AUDIT_CATEGORY_BADGE_CLASSES: Record<string, string> = {
  account: "bg-sky-100 text-sky-800 border-sky-200",
  booking: "bg-emerald-100 text-emerald-800 border-emerald-200",
  payment: "bg-violet-100 text-violet-800 border-violet-200",
  family: `${CHIP_TONE_CLASSES.teal} border-hue-teal/20`,
  admin: "bg-slate-100 text-slate-800 border-slate-200",
  security: "bg-rose-100 text-rose-800 border-rose-200",
  lodge: "bg-amber-100 text-amber-800 border-amber-200",
  xero: "bg-blue-100 text-blue-800 border-blue-200",
  communication: "bg-cyan-100 text-cyan-800 border-cyan-200",
  privacy: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  system: "bg-neutral-100 text-neutral-800 border-neutral-200",
};

/** Badge classes for an audit category, falling back to the `system` tone. */
export function auditCategoryBadgeClass(category: string): string {
  return (
    AUDIT_CATEGORY_BADGE_CLASSES[category] ??
    AUDIT_CATEGORY_BADGE_CLASSES.system
  );
}
