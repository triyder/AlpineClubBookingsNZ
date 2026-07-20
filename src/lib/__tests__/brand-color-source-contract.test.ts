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

// The ONLY file where a literal Tailwind `teal-*` utility is still allowed
// (#2137). The admin booking calendar paints each status as a SOLID swatch
// (`WAITLIST_OFFERED: bg-teal-500`) with no tinted background / accent text
// pairing, and the `--hue-*` system is defined only as such a pair — so there
// is no clean token equivalent for a standalone solid fill.
//
// Every other categorical teal (the waitlist-offered chip, the audit `family`
// badge, the family-group GROUP_CREATE badge, the dashboard Chore Roster tile)
// now reaches its hue through `CHIP_TONE_CLASSES.teal` / the `--hue-teal`
// tokens. Everything else must reach the brand accent through semantic tokens
// (`--primary`, etc.) so it follows the saved site colours.
const CATEGORICAL_TEAL_ALLOWLIST = new Set(
  ["src/components/admin-booking-calendar.tsx"].map((path) =>
    path.replaceAll("\\", "/"),
  ),
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
