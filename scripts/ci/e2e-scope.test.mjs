import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decide, e2eNeeded, pullRequestChangedFiles } from "./e2e-scope.mjs";

describe("e2e-scope: which pull requests the browser suite can skip (#4397)", () => {
  it.each([
    [["docs/E2E_PLAYWRIGHT.md"]],
    [["AGENTS.md", "docs/agents/COORDINATION.md", "changelog.d/4397-fast-e2e.md"]],
    [["src/lib/__tests__/payment.realdb.test.ts", "docs/STATE_MACHINES.md"]],
    [["src/components/booking/Thing.test.tsx"]],
    [["scripts/ci/e2e-scope.test.mjs"]],
    [[".claude/agents/reviewer.md", ".github/pull_request_template.md", ".gitleaksignore"]],
    [["dependency-mitigations.d/1-x.json", "size-allowances.d/1-x.md"]],
  ])("skips a change that cannot reach the suite: %j", (files) => {
    expect(e2eNeeded(files).needed).toBe(false);
  });

  it.each([
    [["src/lib/payment-reconciliation.ts"]],
    [["docs/README.md", "src/app/page.tsx"]],
    [["e2e/waitlist.spec.ts"]],
    [["e2e/README.md"]],
    [["prisma/schema.prisma"]],
    [["prisma/demo-seed.ts"]],
    [["scripts/e2e-stack.sh"]],
    [["scripts/ci/e2e-scope.mjs"]],
    [[".github/workflows/e2e.yml"]],
    [["package.json"]],
    [["pnpm-lock.yaml"]],
    [["Dockerfile"]],
    [["docker-compose.staging.yml"]],
    [["playwright.config.ts"]],
    [["vitest.setup.ts"]],
    [["src/lib/__tests__helpers.ts"]],
    [["public/robots.txt"]],
    [["prisma/migrations/20261026000000_x/README.md"]],
    [["src/lib/help/README.md"]],
  ])("runs the suite for a change that can reach it: %j", (files) => {
    expect(e2eNeeded(files).needed).toBe(true);
  });

  it("runs the suite when the change list is empty or missing", () => {
    expect(e2eNeeded([]).needed).toBe(true);
    expect(e2eNeeded(undefined).needed).toBe(true);
  });

  it("always runs on a push, and on any failure to list the change", () => {
    expect(decide("push", () => ["docs/a.md"]).needed).toBe(true);
    expect(decide("pull_request", () => ["docs/a.md"]).needed).toBe(false);
    expect(decide("pull_request", () => { throw new Error("shallow clone"); }).needed).toBe(true);
  });

  it("reads a merge commit's change with the shared reader, a rename as both paths, and refuses a non-merge HEAD", () => {
    const files = pullRequestChangedFiles({
      run: () => "merge base head\n",
      diff: () => "M\tdocs/a.md\nR100\tsrc/old.ts\tdocs/new.md\n",
    });
    expect(files).toEqual(["docs/a.md", "src/old.ts", "docs/new.md"]);
    expect(e2eNeeded(files).needed).toBe(true);
    expect(() => pullRequestChangedFiles({ run: () => "only-one-commit parent\n", diff: () => "" })).toThrow(/two-parent merge/);
  });

  it("the CLI writes needed=true to GITHUB_OUTPUT on a push", () => {
    const output = path.join(mkdtempSync(path.join(tmpdir(), "e2e-scope-")), "out");
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "e2e-scope.mjs")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("needed=true\n");
  });
});
