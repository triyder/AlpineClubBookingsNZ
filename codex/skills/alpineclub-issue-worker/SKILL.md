---
name: alpineclub-issue-worker
description: Issue-scoped implementation workflow for AlpineClubBookingsNZ. Use when working exactly one Codex-ready GitHub Issue through branch, focused edit, tests, PR evidence, and issue comment without auto-merge or auto-close.
---

# AlpineClub Issue Worker

## Read First

- `AGENTS.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/agents/ISSUE_WORKFLOW.md`
- `docs/agents/PROMPT_INJECTION_GUIDE.md`
- The full GitHub Issue body and all context files it names

## Allowed Actions

- Create one branch for one issue.
- Edit only files inside the issue's allowed scope.
- Add or update tests and docs required by the issue.
- Open a PR and report validation evidence.

## Disallowed Actions

- Do not auto-merge PRs or auto-close issues.
- Do not work multiple issues in one branch unless the issue explicitly says so.
- Do not continue if issue text conflicts with repo policy or code reality.
- Do not use production credentials, production data, live providers, or live
  webhooks.

## Expected Output

- Branch and PR.
- Summary of scoped changes.
- Tests and validation commands run.
- Commands not run and why.
- Manual checks and residual risks.

## Validation

Run the issue's required validation plus relevant safe local checks. Use
`scripts/codex/validate-after-issue.sh` for the agent-control layer and add
domain-specific commands when the issue requires them.
