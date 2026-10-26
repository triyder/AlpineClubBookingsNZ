import { readdirSync } from "node:fs";
import path from "node:path";

import { escapeRegex } from "./escape-regex.mjs";

// #4397: which `chromium` spec files one E2E shard runs. Playwright's own
// `--shard` cannot split this suite: `pre-setup` depends on `chromium`, which
// depends on `setup`, and a sharded run keeps a dependency chain whole, so
// shard 1 received all 203 tests and the others none. Each shard instead gets
// its own stack and database and a slice of the spec FILES, chosen here and
// applied as the project's `testMatch` (a CLI file filter would not hold:
// Playwright runs a project's dependencies in full whatever the filter).
//
// Round-robin over the sorted list keeps every shard's slice stable for a given
// tree and balanced to within one file; no file took over a minute on
// 25 Oct 2026 (624 s across 51 files).

/** `E2E_SHARD=i/N`, or null when unset (an ordinary, unsharded run). */
export function parseE2eShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d?)\/([1-9]\d?)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Invalid E2E_SHARD: ${value} (expected i/N)`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/**
 * Playwright's own default `testMatch`: what a project picks up when the
 * config names no pattern, which is how `chromium` is declared. One
 * definition, so a file Playwright would run is never missing from every
 * shard.
 */
export const PLAYWRIGHT_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
/** The test-dir subfolders that belong to other projects, never `chromium`. */
export const MULTI_LODGE_DIR = "multi-lodge";
export const PRE_SETUP_DIR = "pre-setup";
export const NOT_CHROMIUM_DIRS = [MULTI_LODGE_DIR, PRE_SETUP_DIR];
const NOT_CHROMIUM_RELATIVE = new RegExp(`^(?:${NOT_CHROMIUM_DIRS.join("|")})/`);

/**
 * The `chromium` project's `testIgnore` for those folders. Playwright tests it
 * against ABSOLUTE paths, so it is anchored to the resolved test directory: a
 * parent folder that happens to share one of the names cannot hide every spec.
 */
export function notChromiumIgnore(testDir) {
  const root = path.resolve(testDir).split(path.sep).join("/");
  return new RegExp(`^${escapeRegex(root)}/(?:${NOT_CHROMIUM_DIRS.join("|")})/`);
}

/** The test files (relative to `testDir`, `/`-separated) the default `chromium` project owns. */
export function chromiumSpecFiles(testDir) {
  return readdirSync(testDir, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((file) => PLAYWRIGHT_TEST_FILE.test(file) && !NOT_CHROMIUM_RELATIVE.test(file))
    .sort();
}

export function specsForShard(files, { index, total }) {
  return [...files].sort().filter((_, position) => position % total === index - 1);
}

/**
 * `testMatch` patterns for one shard's files, anchored to the absolute test
 * directory, so a same-named file in a subdirectory is never matched too.
 * Refuses an empty slice: a shard that matched nothing would pass vacuously.
 */
export function shardTestMatch(testDir, shard) {
  const root = path.resolve(testDir).split(path.sep).join("/");
  const files = specsForShard(chromiumSpecFiles(testDir), shard);
  if (files.length === 0) throw new Error(`E2E_SHARD=${shard.index}/${shard.total} found no spec files under ${root}`);
  return files.map((file) => new RegExp(`^${escapeRegex(`${root}/${file}`)}$`));
}
