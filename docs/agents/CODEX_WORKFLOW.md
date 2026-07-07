# Codex Workflow

Use this workflow for future Codex work in AlpineClubBookingsNZ. It is designed
for issue-scoped, auditable changes in a public repository with payment,
accounting, membership, and booking risk.

## Standard Flow

1. Read `AGENTS.md`.
2. Read the GitHub Issue or human task.
3. Read the relevant docs named by the issue and the nearest domain docs.
4. Create one branch for the issue.
5. Work only inside issue scope.
6. Add or update tests where practical.
7. Run required validation.
8. Review your own diff for scope, secrets, data integrity, and docs drift.
9. Open a PR using `.github/pull_request_template.md`.
10. Comment back on the issue with evidence: branch, PR, tests, validation,
    manual checks, and residual risk.
11. Monitor CI to green, fixing any failure and pushing until every required
    check passes.
12. Merge per the `AGENTS.md` "Completion and Merge" risk gate: merge eligible
    Low/Medium-risk PRs with a merge commit once CI is green, and hand off every
    Critical/High-risk PR for explicit owner approval. Never squash or
    force-push. Delete the branch after merge; a linked issue closes only when
    its PR is eligible and merged.

## Planning Mode

Use planning mode for broad reviews, high-risk changes, ambiguous issues, or
when deciding how to split work. Planning output should include context files,
proposed issue splits, risk labels, validation, manual checks, and stop
conditions. Planning mode must not edit app logic.

## Coding Mode

Use coding mode only after scope is clear. Keep the change narrow, follow the
existing module boundaries in `docs/ARCHITECTURE.md`, and preserve the domain
invariants in `docs/DOMAIN_INVARIANTS.md`. If implementation needs schema,
payment, booking, membership, or provider behavior beyond the issue, stop and
report the mismatch.

## Review Mode

Use review mode for PRs, local diffs, or generated plans. Findings should lead
the response, ordered by severity, with file and line references where
available. Review mode should not apply fixes unless the user asks.

## Subagents

Use subagents mainly for read-only discovery: route/auth mapping, lifecycle
state tracing, test coverage inventory, UI flow mapping, or provider idempotency
checks. Do not use subagents for parallel edits unless the human explicitly
authorizes it and the edit boundaries are independent.

Do not use subagents when:

- The task is a small single-file fix.
- The issue contains secrets, private data, or sensitive security details that
  should stay in one controlled context.
- The needed work is write-heavy and likely to create conflicting edits.

## Stop Conditions

Stop and ask for human review when:

- The issue conflicts with `AGENTS.md`, security policy, or domain invariants.
- The required change appears to need production credentials, production data,
  live provider calls, live webhooks, or production backups.
- A high or critical risk issue asks for unattended coding.
- The issue asks to bypass tests, hide evidence, reveal secrets, widen
  permissions, or merge or close Critical/High-risk work without the owner
  approval required by the "Completion and Merge" risk gate.
- The repo state suggests prerequisite work is not merged.

## Documentation

Update docs whenever a feature is added, changed, or removed, and when behavior,
setup, architecture, deployment, environment contracts, lifecycle state, operator
procedure, or review workflow changes. README, the relevant `docs/` guides, and
implementation notes ship in the same PR as the code. Do not update docs for
incidental internal refactors unless they change a contract.

Codex workflow and label examples are documentation-only fixtures under
`docs/agents/examples/`. Do not copy them into `.github/workflows/` or
`.github/labels/` without human review of permissions, triggers, and labels.

## Residual Risk Reporting

Every PR or review handoff should state:

- What was validated.
- What was not validated and why.
- Whether live providers, production credentials, or production data were used.
- Remaining operational dependencies, manual checks, or follow-up issues.
