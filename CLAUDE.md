# Claude Code Guidance

Claude Code agents follow the same contract as every other automated agent in
this repository. **Read [`AGENTS.md`](AGENTS.md) first** and treat it as the
source of truth; this file only highlights the parts that matter most for an
interactive Claude Code session and never overrides `AGENTS.md`.

## Read First

Start with the ordered reading list in `AGENTS.md` ("Read First"):
`README.md`, `CONFIGURATION.md`, `docs/README.md`, `docs/ARCHITECTURE.md`,
`docs/agents/CODEX_WORKFLOW.md`, `docs/DOMAIN_INVARIANTS.md`,
`docs/STATE_MACHINES.md`, `docs/END_TO_END_TEST_MATRIX.md`, and
`docs/UX_FLOW_MAP.md`.

## Finish the job: Completion and Merge

At the successful end of a meaningful piece of work, do not stop at "code
written." Follow `AGENTS.md` → "Completion and Merge":

1. Push the branch and open a PR using `.github/pull_request_template.md`.
2. Monitor CI to green. Fix any failure — lint, typecheck, `npm test`, build,
   migration-drift, dependency/secret/static scans — and push until every
   required check passes. `main` is not branch-protected and can land red, so
   compare against `main`'s own latest CI before assuming a failure is yours.
3. Apply the risk gate:
   - **Auto-merge eligible:** docs, agent workflow, admin/public UI copy, labels,
     help text, and other Low/Medium-risk work that does not touch money,
     booking capacity, membership/family lifecycle, schema/migrations,
     auth/security/privacy, or live providers (Xero/Stripe/SES/Sentry).
   - **Owner approval required:** every Critical/High-risk change in those areas.
     Hand off with full evidence and wait.
4. Merge eligible PRs with a **merge commit** — never squash, rebase-merge, or
   force-push. Close a linked issue only when its PR is eligible and merged.
5. Delete the merged branch and confirm `main` CI stays green.

## Keep docs in lockstep

Whenever a feature is added, changed, or removed, update everything it touches in
the same PR: `README.md`, the relevant `docs/` guides, and any implementation or
operator notes. Keep code, tests, and docs aligned. Skip doc churn only for
incidental internal refactors that change no contract or behavior.

## Safety (see `AGENTS.md` for the full list)

- No production credentials, databases, backups, or live providers (Stripe,
  Xero, SES, Sentry, webhooks) for exploratory work.
- Money stays in integer cents; booking dates stay NZ date-only lodge nights.
- Webhooks and cron jobs stay idempotent; keep external provider calls outside
  long database transactions.
- Security, payment, booking, membership, Xero, and Stripe work needs high or
  xhigh reasoning effort and owner review before merge.

## Local validation

Tests need `DATABASE_URL` pointed at an unreachable dummy (do not point at a live
seeded database). Typical gate before opening a PR:

```bash
npm run lint
npm run db:generate
npm run typecheck
npm test
npm run build
```

Run `npm run db:check-drift` against a shadow database whenever you touch
`prisma/schema.prisma`.
