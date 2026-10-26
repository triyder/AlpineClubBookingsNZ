import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4110: the real-PostgreSQL proof that a closed or voided family is billed
 * again self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches
 * it only because the race harness imports it. Lose that import and the proof
 * silently becomes a no-op while every suite stays green - so the edge is
 * pinned here, as `membership-subscription-charge-close-realdb-wiring.test.ts`
 * pins #4098's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the family re-bill real-database proof stays wired into CI (#4110)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./membership-family-rebill.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/membership-family-rebill.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("re-bills the family after its charge was closed as already paid");
    expect(suite).toContain("re-bills the family after Xero voided its charge");
    expect(suite).toContain("still refuses a second LIVE charge for one family, type and season");
  });
});
