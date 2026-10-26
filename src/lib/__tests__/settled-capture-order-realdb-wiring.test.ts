import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4177 (`INV-PAY-133`): the real-PostgreSQL proof that the duplicate-capture
 * refund names the first-inserted settled capture self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `ledger-insertion-seq-realdb-wiring.test.ts` pins #4132's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the settled-capture order real-database proof stays wired into CI (#4177)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./settled-capture-order.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/settled-capture-order.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("regression pin: captures created apart, the later one first in the heap");
    expect(suite).toContain("proof: captures tied on createdAt, the later one first in the heap");
    expect(suite).toContain("the Xero reader counts a superseded refund until it SUCCEEDED and a cancel only while in flight");
  });
});
