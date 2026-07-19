import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Recursively collect the app/component/lib source files (TS/TSX only). The
// `.css` sheet and the `__tests__` fixtures are excluded: the shims that map
// categorical hues in dark mode legitimately name the Tailwind teal utilities,
// and tests reference the literals they guard.
function listSourceFiles(path: string): string[] {
  return readdirSync(join(process.cwd(), path)).flatMap((entry) => {
    const child = join(path, entry);
    const normalized = child.replaceAll("\\", "/");
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return normalized.includes("/__tests__") ? [] : listSourceFiles(child);
    }
    return /\.tsx?$/.test(entry) ? [child] : [];
  });
}

// Files where a literal Tailwind `teal-*` utility is a deliberate categorical /
// status colour, NOT the brand accent. These render a fixed hue that must stay
// stable across every admin-configured theme (audit categories, the "teal"
// status swatch, calendar legend, dashboard tile). Everything else must reach
// the accent through semantic tokens (`--primary`, etc.) or the `--hue-*`
// system so it follows the saved site colours.
const CATEGORICAL_TEAL_ALLOWLIST = new Set(
  [
    "src/lib/status-colors.ts",
    "src/lib/admin-family-group-ui-helpers.ts",
    "src/components/audit-timeline.tsx",
    "src/components/admin-booking-calendar.tsx",
    "src/app/(admin)/admin/dashboard/page.tsx",
    "src/app/(admin)/admin/audit-log/page.tsx",
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
