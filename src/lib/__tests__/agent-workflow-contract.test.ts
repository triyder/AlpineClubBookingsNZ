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

    expect(agents).toContain("## Orchestration Model");
    expect(agents).toContain("### Concurrency and lock checklist");
    expect(agents).toContain("last 10 merged PRs");
    expect(agents).toContain("global -> lodge -> member");

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
  });

  it("requires every PR to declare concurrency and merge-gate evidence", () => {
    const template = readRepoFile(".github/pull_request_template.md");

    expect(template).toContain("## Concurrency And Lock Impact");
    expect(template).toContain("Writer class(es), canonical lock key(s), and acquisition order:");
    expect(template).toContain("Immutable pre-lock key source and mutable under-lock re-read:");
    expect(template).toContain("Status-guarded claim and proof that a lost claim runs no side effect:");
    expect(template).toContain("Counterpart writers/tests checked (including recent overlapping PRs):");
    expect(template).toContain('Merge handling follows the `AGENTS.md` "Completion and Merge" risk gate');
  });
});
