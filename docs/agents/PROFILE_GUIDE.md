# Profile Guide

Codex profile examples live in `docs/agents/codex/profiles`. They are repository examples,
not installed configuration. Codex local profiles are loaded from
`~/.codex/<profile-name>.config.toml` when selected with
`codex --profile <profile-name>`.

Install examples manually or run:

```bash
scripts/codex/install-local-profiles.sh --install
```

Review the files before installing. Do not add API keys, provider credentials,
or production environment values to profile TOML.

## Suggested Profiles

- `alpine-plan-xhigh`: read-only planning for broad reviews and issue splitting.
- `alpine-review-xhigh`: read-only final review for high-risk diffs.
- `alpine-fix-high`: workspace-write, no network, for supervised fixes.
- `alpine-docs-medium`: workspace-write, no network, for docs-only work.
- `alpine-ui-medium`: workspace-write, no network, for UI-only changes.
- `alpine-autonomous-high`: workspace-write, no network, for low/medium risk
  issue work only after a human accepts the prompt and scope.

## Effort Selection

- `xhigh`: security, payment, booking capacity, membership lifecycle, Xero,
  Stripe, data integrity, broad reviews, and ambiguous planning.
- `high`: focused bug fixes touching domain logic, tests, provider queues,
  auth, cron, or risky admin flows.
- `medium`: docs, UI copy, low-risk UI polish, small test additions, and
  routine issue grooming.
- `low`: trivial formatting, simple file moves, or narrow non-code cleanup.

High and critical risk issues are not unattended coding candidates even if a
profile permits workspace writes.
