import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4250: the real-PostgreSQL proof that a refund note resolved by hand in Xero
 * and later voided covers nothing, and that the card self-heal then re-raises
 * it, self-skips without `RUN_CONCURRENCY_RACE_TESTS`. Hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green, so the edge is pinned
 * here, as `xero-refund-request-note-void-realdb-wiring.test.ts` pins #4195's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the resolved-then-voided refund note's real-database proof stays wired into CI (#4250)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./resolved-voided-refund-note-coverage.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/resolved-voided-refund-note-coverage.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("covers nothing; its id is still reported, never its key");
    expect(suite).toContain("the re-raise takes its old key and is still queued");
    expect(suite).toContain("the nightly card self-heal lists the $250 gap and queues a fresh card note under an after-void key");
  });
});
