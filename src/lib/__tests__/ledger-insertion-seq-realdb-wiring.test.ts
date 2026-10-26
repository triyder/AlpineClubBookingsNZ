import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4132 (`INV-PAY-133`): the real-PostgreSQL proof that a payment's ledger rows
 * keep insertion order on a `createdAt` tie self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `late-capture-own-charge-refund-realdb-wiring.test.ts` pins #4131's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the ledger insertion-order real-database proof stays wired into CI (#4132)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./ledger-insertion-seq.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/ledger-insertion-seq.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the loader, the latest ask, the mirror and the reduction's ask all agree on insertion order");
    expect(suite).toContain("the card refund plan slices newest first by insertion, not by heap order");
    expect(suite).toContain("is numbered above every stored row");
  });
});
