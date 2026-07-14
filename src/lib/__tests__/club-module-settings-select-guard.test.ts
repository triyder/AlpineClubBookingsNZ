import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #153 / #150 guard: every read of the ClubModuleSettings singleton must use
// an explicit column `select` (CLUB_MODULE_SETTINGS_COLUMN_SELECT in
// src/config/modules.ts). A bare findUnique/findMany has no select, so Prisma
// names EVERY schema column — including a retired-but-not-yet-dropped one
// (the former multiLodge flag was the trigger; see #139) — which breaks
// blue/green safety for the eventual DROP. This is a static source scan
// (rather than only per-call-site unit tests) so a future call site that
// forgets the select fails CI immediately instead of relying on someone
// remembering to add a matching mock assertion.

const SRC_DIR = path.join(process.cwd(), "src");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract the balanced-paren call-argument text starting at an opening "(". */
function extractCallArgs(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return source.slice(openParenIndex);
}

describe("ClubModuleSettings reads use an explicit column select", () => {
  it("has no bare clubModuleSettings.findUnique/findMany call anywhere in src/", () => {
    const callPattern = /clubModuleSettings\??\.(findUnique|findMany)\(/g;
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = callPattern.exec(source))) {
        const openParenIndex = match.index + match[0].length - 1;
        const args = extractCallArgs(source, openParenIndex);
        if (!/\bselect\s*:/.test(args)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The config-transfer club-settings category reads the singleton through a
  // generic `delegateOf(...).findUnique(...)` helper, so the literal model
  // name never appears at the call site and the scan above cannot see it.
  // Guard it directly: every findUnique call in that file must thread the
  // per-spec select (only populated for club-module-settings) through.
  it("config-transfer club-settings.ts threads the per-spec select through every findUnique", () => {
    const file = path.join(
      SRC_DIR,
      "lib/config-transfer/categories/club-settings.ts",
    );
    const source = fs.readFileSync(file, "utf8");
    const findUniqueCalls = source.match(/\.findUnique\(/g) ?? [];
    const selectedCalls = source.match(/select:\s*spec\.select/g) ?? [];
    expect(findUniqueCalls.length).toBeGreaterThan(0);
    expect(selectedCalls.length).toBe(findUniqueCalls.length);
  });
});
