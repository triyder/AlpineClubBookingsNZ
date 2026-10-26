import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4098: the real-PostgreSQL proof of closing a subscription charge as already
 * paid self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches
 * it only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `xero-subscription-invoice-retry-realdb-wiring.test.ts` pins
 * #3971's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the close-already-paid real-database proof stays wired into CI (#4098)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./membership-subscription-charge-close.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/membership-subscription-charge-close.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("closes once when two closes race");
    expect(suite).toContain("rolls back whole when a reversal commits while the close waits for the subscription row");
  });
});
