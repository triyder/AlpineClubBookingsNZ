import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Recursively collect the app/component/lib source files (TS/TSX only). The
// `.css` sheet and the `__tests__` fixtures are excluded: the shims that map
// categorical hues in dark mode legitimately name the Tailwind teal utilities,
// and tests reference the literals they guard.
function listSourceFiles(path: string): string[] {
  // A root that has been renamed or moved would otherwise ENOENT-crash the whole
  // suite with an opaque stack; fail with the actual root name instead.
  const root = join(process.cwd(), path);
  if (!existsSync(root)) {
    throw new Error(
      `brand-color-source-contract: source root "${path}" does not exist. ` +
        `If the tree was renamed, update the contract's source roots.`,
    );
  }
  return readdirSync(root).flatMap((entry) => {
    const child = join(path, entry);
    const normalized = child.replaceAll("\\", "/");
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return normalized.includes("/__tests__") ? [] : listSourceFiles(child);
    }
    return /\.tsx?$/.test(entry) ? [child] : [];
  });
}

// #2188 P2 — the theme-aware-kiosk FAMILY is authored in literal slate/colored
// tones and is migrated onto `--kiosk-*` tokens in P3, so BOTH repo-wide
// contracts below carry a TEMPORARY kiosk-family exclusion (B8), removed in P3.
// The family is the kiosk tree PLUS the two shared surfaces that also render
// under `.theme-aware-kiosk` and couple to the `#1249` `html:not(.dark)`
// light-mode override — migrating them in isolation from the kiosk would break
// that coupling, so they stay untouched until #2189 P3.
const KIOSK_FAMILY_TREE = "src/app/(lodge)/lodge/kiosk";
const KIOSK_FAMILY_FILES = new Set(
  [
    // theme-aware-kiosk family — #2189 P3 scope
    "src/app/(lodge)/lodge/roster/[date]/setup/page.tsx",
    // theme-aware-kiosk family — #2189 P3 scope
    "src/components/kiosk-lodge-instructions.tsx",
  ].map((p) => p.replaceAll("\\", "/")),
);

function isKioskFamily(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  return p.startsWith(`${KIOSK_FAMILY_TREE}/`) || KIOSK_FAMILY_FILES.has(p);
}

/** Every TS/TSX source file under `src`, minus `__tests__` and the kiosk family. */
function listRepoSourceFiles(): string[] {
  return listSourceFiles("src").filter((path) => !isKioskFamily(path));
}

// The two files where a literal Tailwind `teal-*` utility is still allowed
// (#2137), each because the `--hue-*` system has no equivalent for the shape of
// colour they need:
//
// - `admin-booking-calendar.tsx` paints each status as a SOLID swatch
//   (`WAITLIST_OFFERED: bg-teal-500`) with no tinted-background / accent-text
//   pairing. `--hue-*` is defined only as such a pair, so there is no clean
//   token equivalent for a standalone solid fill.
// - `admin/dashboard/page.tsx` tints the Chore Roster quick-link tile
//   (`bg-teal-50` + `text-teal-600`). That is the Tailwind -50/-600 tile
//   convention; the `--hue-*` pair is pinned at -100/-800 (see `globals.css`
//   `--hue-teal: #115e59` / `--hue-teal-muted: #ccfbf1`, and the pin in
//   `status-chip.test.tsx`). The tile is the fifth of FIVE identically-built
//   tiles whose blue/green/purple/orange siblings are all -50/-600, so
//   migrating this one alone would visibly break the row's uniformity. Moving
//   the whole row onto a tile-weight hue scale is a deliberate redesign and
//   needs owner sign-off, not a drive-by.
//
// Every other categorical teal (the waitlist-offered chip, the audit `family`
// badge, the family-group GROUP_CREATE badge) now reaches its hue through
// `CHIP_TONE_CLASSES.teal` / the `--hue-teal` tokens — those were already
// -100/-800 pairs, so the migration was value-identical. Everything else must
// reach the brand accent through semantic tokens (`--primary`, etc.) so it
// follows the saved site colours.
const CATEGORICAL_TEAL_ALLOWLIST = new Set(
  [
    "src/components/admin-booking-calendar.tsx",
    "src/app/(admin)/admin/dashboard/page.tsx",
  ].map((path) => path.replaceAll("\\", "/")),
);

describe("brand accent source contract", () => {
  it("keeps the brand accent on semantic tokens, never hardcoded teal", () => {
    const brandTeal = /\b(?:bg|text|border)-teal-\d/;
    const offenders = listSourceFiles("src").filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      if (CATEGORICAL_TEAL_ALLOWLIST.has(normalized)) {
        return false;
      }
      return brandTeal.test(readFileSync(join(process.cwd(), path), "utf8"));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Hardcoded Tailwind teal-* utilities are the brand accent and must ` +
            `not be baked into source. Use semantic tokens (--primary, ` +
            `bg-primary/text-primary-foreground, border-primary/30, ...) so the ` +
            `admin-configured site colours apply, or the --hue-* system for a ` +
            `categorical status hue. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// #2188 P2 (R5) — the NEW repo-wide colored-family source contract. The 16
// colour families (the 17 the scanner tracks minus `teal`, which M9 routes to
// the brand accent and which the brand-accent contract above already gates) must
// not appear as raw Tailwind utilities anywhere in source: every colored surface
// now reaches its hue through the signed-off scale vocabulary — the semantic
// `bg/text/border-<success|warning|info|danger>-<step>` scales, the categorical
// `cat1..cat5` scales, or CHIP_TONE_CLASSES. Repo-wide, kiosk excluded (B8, P3).
const COLORED_FAMILIES_16 = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose",
];

describe("colored-family source contract (R5, 16 families, repo-wide)", () => {
  it("keeps every colored surface on the scale vocabulary, never raw colour utilities", () => {
    const coloredRe = new RegExp(
      `\\b(?:bg|text|border|ring|ring-offset|divide|outline|fill|stroke|from|via|to|accent|caret|decoration|placeholder)-(?:${COLORED_FAMILIES_16.join(
        "|",
      )})-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`,
    );
    const offenders = listRepoSourceFiles().filter((path) =>
      coloredRe.test(readFileSync(join(process.cwd(), path), "utf8")),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Raw Tailwind colour-family utilities must not be baked into source. ` +
            `Use the semantic step scales (bg-danger-3/text-danger-11/…), the ` +
            `categorical scales (bg-cat1-3/…), or CHIP_TONE_CLASSES so the ` +
            `surface follows the club theme. The kiosk tree is exempt until P3. ` +
            `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// The /finance and admin surfaces render inside `app-theme-scope` (see
// `src/app/(finance)/finance/layout.tsx` and the admin layout), which applies
// the club theme.
//
// WHY this matters — precisely. `globals.css` already carries a
// `.dark .app-theme-scope` neutral remap (the #1263 follow-up block) that
// rewrites raw `bg-white`, `bg-{neutral}-50/100/200`, `text-{neutral}-300..950`,
// and `border-{neutral}-100..300` onto `--card` / `--muted` / `--border` /
// `--foreground` / `--muted-foreground`. So dark mode was NOT broken before
// #2137 — that shim covered it. But the shim is `.dark`-ONLY: in LIGHT mode a
// raw neutral stays literally slate/white and does not follow a strongly
// non-default club theme. Using the semantic tokens directly fixes that gap and
// means the surface is correct at source rather than correct-by-shim.
//
// #2137 migrated the finance tree; #2144 swept the ~1,400 raw-neutral
// occurrences out of the admin tree onto the same tokens, so both trees are
// now gated. (Raw hex still exists in finance for chart colours —
// `FINANCE_MIX_COLORS`, `ratio-explorer.tsx`, `trend-chart.tsx` — which is the
// deliberate #1801 SVG-presentation-attribute carve-out and is out of scope
// for this check.)
//
// #2188 P2 — the neutral contract is now REPO-WIDE (kiosk excluded, B8/P3) via
// `listRepoSourceFiles()`, after P2 migrated every member-facing tree onto the
// shadcn role tokens and deleted the `.dark .app-theme-scope` neutral remap. The
// admin/finance roots that used to be listed here are subsumed by the repo-wide
// scan; the deliberate exceptions live in THEMED_NEUTRAL_ALLOWLIST above.

// Admin-only leaves kept as an explicit existence guard so a rename surfaces as a
// clear failure rather than silently dropping coverage.
const THEMED_TOKEN_ONLY_FILES = [
  "src/components/admin-booking-calendar.tsx",
  "src/components/admin-hub-page.tsx",
  "src/components/admin-permission-matrix-table.tsx",
  "src/lib/admin-family-group-ui-helpers.ts",
];

// Per-FILE exceptions, each with a stated reason. NOTE the granularity: an
// entry exempts the whole file, so it forfeits gate coverage on that file's
// OTHER occurrences too — keep entries to files whose raw neutrals are
// wholly deliberate, and prefer fixing a stray over adding an entry.
const THEMED_NEUTRAL_ALLOWLIST = new Set<string>(
  [
    // Fixed code-preview panes, deliberately theme-isolated; the literal
    // slate strings are REQUIRED by `app-theme-layout-contract.test.ts`
    // ("keeps Site Style app chrome semantic while fixed code previews stay
    // isolated").
    "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    // Print pages: self-consistent hard-light paper surfaces. `bg-white`,
    // `border-gray-400` rules and grey ink are correct for paper output and
    // must not follow the club theme.
    "src/app/(admin)/admin/roster/[date]/print/page.tsx",
    "src/app/(admin)/admin/induction/[id]/print/page.tsx",
    // Reports: the six `print:border-slate-300` PRINT-ONLY variants (the
    // file's screen classes are fully tokenised). Print output is paper, not
    // theme.
    "src/app/(admin)/admin/reports/page.tsx",
    // Signage: `bg-black` letterboxes simulating a display screen.
    "src/app/(admin)/admin/display/builder/display-builder.tsx",
    "src/app/(admin)/admin/display/preview/page.tsx",
    // Solid-fill chips paired with `text-white` (`bg-slate-600 text-white`,
    // `border-slate-900 bg-slate-900 text-white`): opaque status chips, not
    // surfaces — the dark shim deliberately does not remap them.
    "src/components/admin/xero-record-activity-panel.tsx",
    // `border-slate-900` on the active wizard-step chip: a solid near-black
    // emphasis border outside the shim's border-{n}-100..300 remap range.
    "src/app/(admin)/admin/members/_components/member-import-dialog.tsx",
    // Solid booking-status swatches (`DRAFT: bg-gray-300`, `bg-gray-400`
    // fallback): standalone opaque fills with no tinted/accent pairing, the
    // same shape as this file's teal allowlist entry above.
    "src/components/admin-booking-calendar.tsx",
    // NOTE: the roster-setup page and kiosk-lodge-instructions are NOT here —
    // they are theme-aware-kiosk FAMILY surfaces, covered by the kiosk-family
    // EXCLUSION (isKioskFamily, B8, deleted in P3), not by this allowlist. The
    // allowlist must never carry deferred work.
    //
    // #2188 P2 additions (repo-wide widening).
    // Un-themed system pages: React error/404 boundaries render OUTSIDE
    // app-theme-scope, so there is no club theme to follow — raw neutrals are
    // correct there.
    "src/app/error.tsx",
    "src/app/not-found.tsx",
    // Radix overlay scrims / decorative black overlays (`bg-black/80`,
    // `bg-black/10`): opacity scrims over the page, not theme surfaces.
    "src/components/ui/dialog.tsx",
    "src/components/ui/sheet.tsx",
    "src/components/site-banners.tsx",
  ].map((path) => path.replaceAll("\\", "/")),
);

describe("themed-surface neutral contract (repo-wide, #2188 P2)", () => {
  it("keeps every themed surface on theme tokens, never raw neutrals or bg-white", () => {
    // The repo's own dark shim treats slate/gray/zinc/neutral/stone as ONE
    // family, so this matches the whole family rather than slate alone. Note
    // `text-white` is NOT matched: it is a legitimate paired foreground on a
    // coloured fill (e.g. `bg-brand-charcoal text-white`) and the shim does not
    // remap it either.
    const rawNeutral =
      /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone)-\d|\b(?:bg|text)-black\b|\bbg-white\b/;
    for (const file of THEMED_TOKEN_ONLY_FILES) {
      if (!existsSync(join(process.cwd(), file))) {
        throw new Error(
          `brand-color-source-contract: gated file "${file}" does not exist. ` +
            `If it was renamed or moved, update THEMED_TOKEN_ONLY_FILES.`,
        );
      }
    }
    // #2188 P2 — widened from the admin/finance roots to the WHOLE repo (kiosk
    // excluded, B8/P3) so raw neutrals cannot re-enter any themed surface. The
    // per-file allowlist above carries the deliberate exceptions.
    const offenders = listRepoSourceFiles().filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      if (THEMED_NEUTRAL_ALLOWLIST.has(normalized)) {
        return false;
      }
      return rawNeutral.test(readFileSync(join(process.cwd(), path), "utf8"));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The admin and /finance surfaces render inside app-theme-scope, so ` +
            `raw neutral/bg-white utilities do not follow the club theme in ` +
            `LIGHT mode (the .dark .app-theme-scope shim in globals.css only ` +
            `covers dark). Use the semantic tokens instead: ` +
            `bg-card/text-card-foreground for card surfaces, ` +
            `bg-popover/text-popover-foreground for floating panels, ` +
            `text-muted-foreground for secondary labels, bg-muted for tinted ` +
            `rows and recessed insets, border-border for rules. A wholly ` +
            `deliberate exception needs a per-file THEMED_NEUTRAL_ALLOWLIST ` +
            `entry with a stated reason. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
