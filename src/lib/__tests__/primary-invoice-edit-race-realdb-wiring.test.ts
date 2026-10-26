import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3980: the PostgreSQL proof of an edit racing the primary invoice create
 * self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only
 * through the race harness's import. Lose the import and the proof silently
 * stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the primary invoice edit-race proof stays wired into CI (#3980)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./primary-invoice-edit-race.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/primary-invoice-edit-race.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a price increase committed mid-create is billed once");
    expect(suite).toContain("a reduction committed mid-create raises one Xero Operations task");
    expect(suite).toContain("an edit arriving while the link's save holds the Payment row is refused whole");
    expect(suite).toContain("the link's save queues behind an edit that has claimed");
  });
});
