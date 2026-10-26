import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4149: the real-PostgreSQL proof that a late capture's lost automatic-refund
 * record is written once self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and
 * hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `late-capture-own-charge-refund-realdb-wiring.test.ts`
 * pins #4131's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the late-capture record recovery real-database proof stays wired into CI (#4149)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./late-capture-record-recovery.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/late-capture-record-recovery.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the self-heal writes the lost record before it could raise a note");
    expect(suite).toContain("two redeliveries racing the self-heal still write one record and one entry");
  });
});
