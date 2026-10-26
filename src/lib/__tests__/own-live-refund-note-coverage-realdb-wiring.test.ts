import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4265: the real-PostgreSQL proof that a refund-note row covers only its own
 * live, non-request note (with #4258 and #4321 folded in) self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`. Hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green, so the edge is pinned here, as
 * `resolved-voided-refund-note-coverage-realdb-wiring.test.ts` pins #4250's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the own-live refund-note coverage real-database proof stays wired into CI (#4265)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./own-live-refund-note-coverage.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/own-live-refund-note-coverage.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a refund request's own note resolved by hand covers nothing, live or voided");
    expect(suite).toContain("is undone, not a spare");
    expect(suite).toContain("a close row completed as covered by another refund's note counts nothing of its own");
    expect(suite).toContain("the hand-made answer refuses a note a row resolved by hand records");
  });
});
