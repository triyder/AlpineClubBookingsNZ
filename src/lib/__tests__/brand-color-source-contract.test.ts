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
        `If the tree was renamed, update THEMED_TOKEN_ONLY_ROOTS.`,
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

// The /finance surface renders inside `app-theme-scope` (see
// `src/app/(finance)/finance/layout.tsx`), which applies the club theme.
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
// The finance tree is free of raw neutral/white Tailwind utilities, so this
// check runs with an EMPTY allowlist. (Raw hex still exists there for chart
// colours — `FINANCE_MIX_COLORS`, `ratio-explorer.tsx`, `trend-chart.tsx` — which
// is the deliberate #1801 SVG-presentation-attribute carve-out and is out of
// scope for this check.)
//
// Deliberately NOT repo-wide: `src/` still has ~160 files carrying raw slate
// (about 111 of them under the admin tree), so a repo-wide version would need a
// huge allowlist and would assert nothing useful. Widening it to the admin
// surface is a follow-up that has to migrate those files first.
const THEMED_TOKEN_ONLY_ROOTS = ["src/app/(finance)", "src/components/finance"];

// Intentionally EMPTY. It exists so a future legitimate exception is an obvious,
// reviewable one-line addition with a stated reason, rather than someone
// deleting or narrowing the test.
const THEMED_NEUTRAL_ALLOWLIST = new Set<string>([]);

describe("themed-surface neutral contract", () => {
  it("keeps the /finance surface on theme tokens, never raw neutrals or bg-white", () => {
    // The repo's own dark shim treats slate/gray/zinc/neutral/stone as ONE
    // family, so this matches the whole family rather than slate alone. Note
    // `text-white` is NOT matched: it is a legitimate paired foreground on a
    // coloured fill (e.g. `bg-brand-charcoal text-white`) and the shim does not
    // remap it either.
    const rawNeutral =
      /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone)-\d|\b(?:bg|text)-black\b|\bbg-white\b/;
    const offenders = THEMED_TOKEN_ONLY_ROOTS.flatMap(listSourceFiles).filter(
      (path) => {
        const normalized = path.replaceAll("\\", "/");
        if (THEMED_NEUTRAL_ALLOWLIST.has(normalized)) {
          return false;
        }
        return rawNeutral.test(readFileSync(join(process.cwd(), path), "utf8"));
      },
    );

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The /finance surface renders inside app-theme-scope, so raw ` +
            `neutral/bg-white utilities do not follow the club theme in LIGHT ` +
            `mode (the .dark .app-theme-scope shim in globals.css only covers ` +
            `dark). Use the semantic tokens instead: bg-card/text-card-foreground ` +
            `for card surfaces, bg-popover/text-popover-foreground for floating ` +
            `panels, text-muted-foreground for secondary labels, bg-muted for ` +
            `tinted rows, border-border for rules. Offenders:\n` +
            `${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
