import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4357 (`INV-PAY-119`): the real-PostgreSQL proof that every saved-card door
 * charges the booking's worth self-skips without `RUN_CONCURRENCY_RACE_TESTS`,
 * and hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `third-duplicate-capture-realdb-wiring.test.ts`
 * pins #4211's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the saved-card charge worth real-database proof stays wired into CI (#4357)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./saved-card-charge-worth.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/saved-card-charge-worth.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the charge-saved-method route charges worth and the settle takes it");
    expect(suite).toContain("the officer's confirm-pending-guests route charges worth and the settle takes it");
  });
});
