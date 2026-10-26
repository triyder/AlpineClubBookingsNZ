import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4421: the real-PostgreSQL proof that "Resolve by hand" records the refund
 * note the officer made, once, against the #4162 hand-made answer, self-skips
 * without `RUN_CONCURRENCY_RACE_TESTS`. Hosted CI reaches it only because the
 * race harness imports it. Lose that import and the proof silently becomes a
 * no-op while every suite stays green, so the edge is pinned here, as
 * `own-live-refund-note-coverage-realdb-wiring.test.ts` pins #4265's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the resolve-records-refund-note real-database proof stays wired into CI (#4421)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./resolve-records-refund-note.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/resolve-records-refund-note.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a resolve records the note it was given; the hand-made answer then refuses that note");
    expect(suite).toContain("once the hand-made answer records the note, a resolve offering it is refused");
    expect(suite).toContain("a resolve arriving while the answer holds its locks past its guard waits on lock(1), then refuses");
    expect(suite).toContain("an answer arriving while the resolve holds lock(1) past its checks waits, then refuses");
    expect(suite).toContain("once Xero voids the note a resolve recorded, the link records the void");
    expect(suite).toContain("once the row's retry made CN-0200, a resolve with a hand-made note for the same $200 is refused");
  });
});
