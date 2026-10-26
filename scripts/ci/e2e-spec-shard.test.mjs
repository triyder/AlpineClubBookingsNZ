import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PLAYWRIGHT_TEST_FILE,
  notChromiumIgnore,
  chromiumSpecFiles,
  parseE2eShard,
  shardTestMatch,
  specsForShard,
} from "./e2e-spec-shard.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("E2E spec shards (#4397)", () => {
  it("parses E2E_SHARD, treating unset as an unsharded run and refusing a bad value", () => {
    expect(parseE2eShard(undefined)).toBeNull();
    expect(parseE2eShard("")).toBeNull();
    expect(parseE2eShard("2/3")).toEqual({ index: 2, total: 3 });
    for (const bad of ["0/3", "4/3", "3", "a/b", "1/0", "1/3 "]) expect(() => parseE2eShard(bad)).toThrow(/Invalid E2E_SHARD/);
  });

  it("splits the real chromium specs into disjoint shards that together hold every spec exactly once", () => {
    const files = chromiumSpecFiles(path.join(root, "e2e"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.startsWith("multi-lodge/") || file.startsWith("pre-setup/"))).toBe(false);
    for (const total of [1, 2, 3, 4]) {
      const shards = Array.from({ length: total }, (_, i) => specsForShard(files, { index: i + 1, total }));
      expect(shards.flat().sort()).toEqual(files);
      expect(new Set(shards.flat()).size).toBe(files.length);
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("anchors each shard's patterns to the absolute test dir, and refuses a shard with no files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "e2e-shard-"));
    mkdirSync(path.join(dir, "sub"));
    mkdirSync(path.join(dir, "pre-setup"));
    for (const file of ["waitlist.spec.ts", "admin-waitlist.spec.ts", "sub/waitlist.spec.ts", "pre-setup/gate.spec.ts", "notes.ts"]) {
      writeFileSync(path.join(dir, file), "");
    }
    expect(chromiumSpecFiles(dir)).toEqual(["admin-waitlist.spec.ts", "sub/waitlist.spec.ts", "waitlist.spec.ts"]);
    const patterns = shardTestMatch(dir, { index: 1, total: 1 });
    const root = path.resolve(dir).split(path.sep).join("/");
    const matches = (file) => patterns.some((pattern) => pattern.test(`${root}/${file}`));
    expect(matches("waitlist.spec.ts")).toBe(true);
    expect(matches("sub/waitlist.spec.ts")).toBe(true);
    expect(patterns.filter((pattern) => pattern.test(`${root}/sub/waitlist.spec.ts`))).toHaveLength(1);
    expect(matches("pre-setup/gate.spec.ts")).toBe(false);
    expect(() => shardTestMatch(path.join(dir, "sub"), { index: 2, total: 2 })).toThrow(/found no spec files/);
  });

  it("keeps Playwright's default test-file shapes, and ignores its two other projects' dirs by absolute or relative path", () => {
    for (const file of ["a.spec.ts", "a.test.ts", "a.spec.tsx", "a.spec.mjs", "a.test.js"]) expect(PLAYWRIGHT_TEST_FILE.test(file)).toBe(true);
    for (const file of ["auth.setup.ts", "helpers/x.ts", "a.spec.ts.snap"]) expect(PLAYWRIGHT_TEST_FILE.test(file)).toBe(false);
    const ignore = notChromiumIgnore("/home/runner/repo/e2e");
    for (const file of ["/home/runner/repo/e2e/pre-setup/a.spec.ts", "/home/runner/repo/e2e/multi-lodge/b.spec.ts"]) expect(ignore.test(file)).toBe(true);
    for (const file of ["/home/runner/repo/e2e/booking.spec.ts", "/home/runner/repo/e2e/not-multi-lodge-x.spec.ts"]) expect(ignore.test(file)).toBe(false);
    // A parent folder sharing a name must not hide the whole suite.
    expect(notChromiumIgnore("/src/worktrees/pre-setup/e2e").test("/src/worktrees/pre-setup/e2e/booking.spec.ts")).toBe(false);
  });
});
