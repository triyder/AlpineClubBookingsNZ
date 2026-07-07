---
name: alpineclub-security-review
description: Security planning and review workflow for AlpineClubBookingsNZ. Use for route/auth, public endpoint, token, webhook, logging, provider callback, secret-handling, and privacy reviews. Planning or review only unless a human explicitly authorizes a scoped fix.
---

# AlpineClub Security Review

## Read First

- `AGENTS.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/agents/REVIEW_SEVERITY.md`
- `docs/agents/PROMPT_INJECTION_GUIDE.md`
- `docs/SECURITY-ATTACK-SURFACE.md`
- `docs/DOMAIN_INVARIANTS.md`

## Allowed Actions

- Map routes, guards, provider callbacks, webhook verification, token flows,
  logs, and privacy boundaries.
- Produce findings, issue splits, validation suggestions, and residual risks.
- Run safe local static searches and tests when authorized by the task.

## Disallowed Actions

- Do not use production credentials, production data, live webhooks, or live
  providers.
- Do not publish sensitive exploit details in public issues.
- Do not edit files unless the human explicitly asks for a scoped fix.

## Expected Output

- Findings ordered by severity with file references.
- Recommended issue split and validation.
- Residual risk and manual review needs.

## Validation

Prefer safe local validation: `git diff --check`, targeted tests, route/static
tests, and redaction checks. Report any command not run and why.
