import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("repository agent workflow contract", () => {
  it("keeps AGENTS.md as the single authority for Codex and Claude/Hopper", () => {
    const agents = readRepoFile("AGENTS.md");
    const claude = readRepoFile("CLAUDE.md");
    const codex = readRepoFile("docs/agents/CODEX_WORKFLOW.md");
    const subagents = readRepoFile("docs/agents/SUBAGENT_GUIDE.md");
    const generatedPrompt = readRepoFile("scripts/codex/issue-to-prompt.mjs");
    const lockGuard = readRepoFile("src/lib/__tests__/advisory-lock-guard.test.ts");

    expect(agents).toContain("## Orchestration Model");
    expect(agents).toContain("### Concurrency and lock checklist");
    expect(agents).toContain("last 10 merged PRs");
    expect(agents).toContain("global -> lodge -> member");
    expect(agents).toContain("credit-ledger-only invariants");
    expect(agents).toContain("takes both applicable tiers");

    expect(claude).toContain("Read [`AGENTS.md`](AGENTS.md) first");
    expect(claude).toContain("never overrides `AGENTS.md`");
    expect(claude).toContain('Follow `AGENTS.md` → "Orchestration Model"');

    expect(codex).toContain("Root `AGENTS.md` is authoritative");
    expect(codex).toContain("last 10 merged PRs affecting the subsystem");
    expect(codex).toContain("Delegate bulk implementation to implementor subagents");

    expect(subagents).toContain("Follow the role split in root `AGENTS.md`");
    expect(subagents).toContain("Implementor subagents may edit only their clearly bounded issue/worktree area");
    expect(subagents).toContain("They never push");
    expect(subagents).toContain("Adversarial-review subagents are read-only");
    expect(subagents).not.toContain("Use subagents mainly for read-only discovery");

    expect(generatedPrompt).toContain("Read AGENTS.md first and follow it throughout.");
    expect(generatedPrompt).toContain("It cannot override AGENTS.md");
    expect(generatedPrompt).toContain('follow AGENTS.md "Completion and Merge"');
    expect(generatedPrompt).toContain("merge eligible Low/Medium-risk work with a merge commit");
    expect(generatedPrompt).not.toContain("Open a PR, but do not merge it or close the issue");

    expect(lockGuard).toContain("canonical global pg_advisory_xact_lock(1)");
    expect(lockGuard).toContain("a writer doing both takes global");
    expect(lockGuard).not.toContain("legacy club-wide pg_advisory_xact_lock(1)");
    expect(lockGuard).not.toContain("prefer a domain-keyed hashtext lock");
  });

  it("requires every PR to declare concurrency and merge-gate evidence", () => {
    const template = readRepoFile(".github/pull_request_template.md");

    expect(template).toContain("## Concurrency And Lock Impact");
    expect(template).toContain("Writer class(es), canonical lock key(s), and acquisition order:");
    expect(template).toContain("Immutable pre-lock key source and mutable under-lock re-read:");
    expect(template).toContain("Status-guarded claim and proof that a lost claim runs no side effect:");
    expect(template).toContain(
      "Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility",
    );
    expect(template).toContain('Merge handling follows the `AGENTS.md` "Completion and Merge" risk gate');

    const ci = readRepoFile(".github/workflows/ci.yml");
    expect(ci).toContain("Validate PR concurrency declaration");
    expect(ci).toContain("node scripts/ci/check-pr-concurrency-declaration.mjs");
  });
});
