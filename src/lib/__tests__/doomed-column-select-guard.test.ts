import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #2130 guard (same shape as club-module-settings-select-guard.test.ts): every
// read AND write of XeroItemCodeMapping and AgeTierSetting must name its
// columns with an explicit `select`. Both models still carry columns that a
// later contract migration drops — XeroItemCodeMapping.isMember and
// AgeTierSetting.xeroContactGroupId/xeroContactGroupName — and a bare
// findUnique/findFirst/findMany/create/update/upsert makes Prisma name EVERY
// scalar column in the SELECT or in a write's implicit RETURNING. A draining
// old colour issuing that SQL after the drop gets Postgres 42703
// ("column ... does not exist"), which is exactly the blue/green break the
// #2130 runtime-prep → contract two-step exists to prevent.
//
// This is a static source scan rather than only per-call-site mock pins so a
// NEW call site added between the runtime-prep release and the contract
// migration fails CI immediately, instead of relying on someone remembering to
// add a matching mock assertion. Unlike the ClubModuleSettings guard this
// surface also spans prisma/seed.ts and scripts/, so all three roots are
// walked.
//
// deleteMany/updateMany/count/aggregate/groupBy are deliberately NOT scanned:
// they emit no RETURNING and project no columns, so they are safe unnarrowed.

const SCAN_ROOTS = ["src", "prisma", "scripts"].map((dir) =>
  path.join(process.cwd(), dir),
);

const DOOMED_COLUMN_MODELS = ["xeroItemCodeMapping", "ageTierSetting"];

const PROJECTING_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "update",
  "upsert",
  "delete",
];

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests are not runtime: their mocks and assertions mention the
      // delegates without issuing SQL, so scanning them only produces noise.
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(full, files);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
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

describe("doomed-column models are read and written with an explicit select", () => {
  it("has no bare XeroItemCodeMapping/AgeTierSetting projecting call in src/, prisma/ or scripts/", () => {
    const callPattern = new RegExp(
      `(?:${DOOMED_COLUMN_MODELS.join("|")})\\??\\.(?:${PROJECTING_METHODS.join(
        "|",
      )})\\(`,
      "g",
    );
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const source = fs.readFileSync(file, "utf8");
        let match: RegExpExecArray | null;
        callPattern.lastIndex = 0;
        while ((match = callPattern.exec(source))) {
          const openParenIndex = match.index + match[0].length - 1;
          const args = extractCallArgs(source, openParenIndex);
          const line = source.slice(0, match.index).split("\n").length;
          const location = `${path
            .relative(process.cwd(), file)
            .replace(/\\/g, "/")}:${line}`;
          scanned.push(location);
          if (!/\bselect\s*:/.test(args)) offenders.push(location);
        }
      }
    }

    // Sanity: if the scan finds nothing at all the guard has silently stopped
    // covering the surface (moved files, renamed delegates) and would pass
    // vacuously forever.
    expect(scanned.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
