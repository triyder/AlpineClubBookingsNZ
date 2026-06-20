---
name: alpineclub-ux-review
description: UI/UX and accessibility planning review workflow for AlpineClubBookingsNZ. Use for persona journeys, member/admin/lodge/finance flows, explanatory copy, next actions, empty/pending/failure states, screenshots, and non-production accessibility checks.
---

# AlpineClub UX Review

## Read First

- `AGENTS.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/UX_FLOW_MAP.md`
- `docs/END_TO_END_TEST_MATRIX.md`
- `docs/STAGING_ACCESSIBILITY.md`

## Allowed Actions

- Map journeys, copy gaps, next-action visibility, failure states, and
  accessibility concerns.
- Suggest issue splits and manual staging checks.
- Edit UI only when a focused issue explicitly authorizes it.

## Disallowed Actions

- Do not run browser automation or accessibility tooling against production.
- Do not use production user accounts or copied production data.
- Do not alter business logic, payment behavior, schema, or provider config for
  UI-only issues.

## Expected Output

- Journey findings by persona and severity.
- Manual route checks, screenshots needed, accessibility checks, and residual
  risks.

## Validation

Use component tests, lint, and non-production staging accessibility checks when
requested. Record routes, roles, tools, and results.
