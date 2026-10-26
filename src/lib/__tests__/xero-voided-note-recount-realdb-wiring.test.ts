import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4291: the real-PostgreSQL proof that a voided refund note's later inbound
 * events still recount its payment self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `xero-partial-repair-claim-realdb-wiring.test.ts` pins #4256's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the voided refund note recount's real-database proof stays wired into CI (#4291)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./xero-voided-note-recount.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/xero-voided-note-recount.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("its retry recounts the payment, and the mirror stays off");
    expect(suite).toContain("does not resolve when Xero voids it");
    expect(suite).toContain("a read of the note as live never resolves its voided mirror");
  });
});
