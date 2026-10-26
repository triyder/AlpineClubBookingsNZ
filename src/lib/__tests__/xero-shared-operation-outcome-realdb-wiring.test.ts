import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4356: the real-PostgreSQL proof that two callers sharing one Xero operation
 * row never let a failure overwrite a recorded success (`INV-INT-029`)
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it
 * only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `xero-partial-repair-claim-realdb-wiring.test.ts` pins #4256's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the shared operation row's real-database proof stays wired into CI (#4356)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    // A whole live line: a commented-out import does not count.
    expect(harness).toMatch(/^import "\.\/xero-shared-operation-outcome\.realdb\.test";$/m);
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-shared-operation-outcome.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toMatch(/^const RUN = process\.env\.RUN_CONCURRENCY_RACE_TESTS === "1";$/m);
    // The suite runs when the harness sets the flag, rather than always skipping.
    expect(suite).toMatch(/^\(RUN \? describe : describe\.skip\)\($/m);
    expect(suite).toContain("W succeeds, then L fails on W's row: the row stays SUCCEEDED");
    expect(suite).toContain("L succeeds first, then W fails");
    expect(suite).toContain("W fails, then L succeeds: the success replaces the failure");
    expect(suite).toContain("a late failure never lands on a PARTIAL repair's claim");
    expect(suite).toContain("a late failure never lands on a refund-note repair's claim");
    expect(suite).toContain("a PARTIAL completion after a SUCCEEDED on the same row is refused");
  });
});
