---
name: alpineclub-lifecycle-review
description: Lifecycle planning and review workflow for AlpineClubBookingsNZ. Use for booking, waitlist, membership application, nomination, cancellation, archive, delete, family/dependent, email retry, Xero outbox, and cron recovery state-machine reviews.
---

# AlpineClub Lifecycle Review

## Read First

- `AGENTS.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/STATE_MACHINES.md`
- `docs/END_TO_END_TEST_MATRIX.md`
- `docs/ARCHITECTURE.md`

## Allowed Actions

- Trace state transitions and terminal states.
- Identify missing expiry, retry, admin visibility, and repair paths.
- Map needed tests and issue splits.

## Disallowed Actions

- Do not change application logic unless explicitly authorized by a focused
  issue.
- Do not widen scope into payment/provider/schema work unless the issue allows
  it.
- Do not use production data or live providers.

## Expected Output

- State-machine findings with affected paths.
- Open questions marked "to verify" when exact states are uncertain.
- Tests, validation, manual checks, and residual risk.

## Validation

Use targeted unit/service tests and safe static searches. For high-risk flows,
require human review before any implementation PR.
