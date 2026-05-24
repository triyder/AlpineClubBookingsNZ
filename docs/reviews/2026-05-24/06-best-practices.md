# Best practice recommendations

Themes that emerged from the 48-hour audit. These are process and discipline recommendations to reduce the chance of the same classes of issue recurring as the codebase grows.

## Email and notification discipline

- **Registry coverage test**: add a vitest that scans `src/lib/email.ts` for every `sendEmail({ templateName: ... })` call and asserts the `templateName` exists in `EMAIL_AUDIT_DEFAULTS`. Catches a hardcoded body before review.
- **One-to-one admin preference key per outbound system email**: every new admin alert needs its own key in `ADMIN_NOTIFICATION_PREFERENCE_META`, with a migration that backfills existing rows to `true`. Avoid the temptation to reuse an existing key, even if conceptually similar (the booking change request finding is the textbook example).
- **Audit doc refresh**: every email-touching PR updates `docs/email-message-audit.md` in the same commit. Make this part of the PR checklist.

## Schema and migration discipline

- **One naming convention per code generation**: when several features ship in the same window, pick FK column conventions (`requesterId` vs `requestedByMemberId`) and status enum vocabulary (`PENDING / RESOLVED / DECLINED` vs `REQUESTED / APPROVED / REJECTED`) once. Document the chosen idiom in `docs/ARCHITECTURE.md`. Drift here makes future agents introduce yet another variant.
- **CHECK constraints on invariants the code assumes**: where business logic depends on a column relationship (e.g. `stayStart < stayEnd`, `archivedAt IS NULL` exclusivity), add the constraint at the DB layer. Code-only invariants drift over time.
- **Document explicit FK omissions**: when a model intentionally has no FK (snapshot-style audit rows), repeat the rationale in `schema.prisma`, not just in the migration SQL. Schema readers don't always read migration history.
- **Down-migration policy**: confirm whether the project intends to support down migrations. None present in this window; pick a stance and document.

## Concurrency and transactional discipline

- **Two patterns, picked deliberately**: for any approve/reject-style state machine, choose between:
  - `updateMany` with guards in `where` and check `count === 1` (preferred for single-row state transitions)
  - `pg_advisory_xact_lock` (already used in `bookings/[id]/modify/route.ts:143`; preferred when multiple rows must be locked coherently)
  Standardise on one of these and add a comment explaining the choice. The current code mixes plain `findUnique` + `update` with one or the other.
- **Document isolation level**: where `READ COMMITTED` is insufficient, set `isolationLevel: 'Serializable'` explicitly and add a test that exercises the concurrent path.
- **Tx vs post-tx side effects**: anything that touches an external system (Stripe, Xero, email) and matters to correctness should be: (a) inside the transaction if the external call is idempotent and the DB write must reflect external success, or (b) enqueued through a durable retry queue (like `PaymentRecoveryOperation`). Avoid bare fire-and-forget with `logger.error` fallback.

## Stripe and Xero integration discipline

- **Money flow checklist on every Stripe-touching PR**:
  - Idempotency key construction (deterministic, unique per logical operation)
  - Retry path (durable queue, not in-process)
  - Failure path (admin alert, not silent log)
  - Webhook event coverage (which event re-drives state if the inline path fails)
  - Test coverage of at least one partial-failure scenario
- **Document the cron scheduler contract**: the recovery queue requires `/api/cron/payments?task=recovery` to be hit externally. Add this to `DEPLOYMENT.md` plus a health check that alerts if any `PaymentRecoveryOperation` row is `PENDING` for more than ~15 minutes.
- **Symmetric cleanup helpers**: extract zero-dollar superseded-intent cleanup into a single helper called by both `modify/route.ts` and `modify-dates/route.ts`. Asymmetric in-route logic is the most common source of drift.
- **`WAITING_PAYMENT` reaper**: every gated outbox status needs a reaper. Add one for `WAITING_PAYMENT` Xero ops where the linked `PaymentTransaction` is `FAILED` or older than N days.
- **Test the failed half**: every test that asserts the happy path must have a sibling that asserts the partial-failure path. Missing today for: PAID-subscription cancellation, DB failure between Stripe refund and ledger entry, stale `PROCESSING` recovery ops at max attempts.

## Security baseline

- **Tokens in URL paths**: prefer query strings (still indexed by Next.js routing but easier to scrub from logs) or hash fragments (never sent to server). Add a Pino redact rule for `/membership-cancellation/[^/]+` paths. Same applies to any future token-bearing route.
- **Rate limit on every public-token route**: the new cancellation flow does this correctly. Make it a checklist item for any new public/tokenised endpoint.
- **Admin role check at the route level, never UI-only**: this is consistently done today. Reinforce it in the PR template.

## Code structure discipline

- **Route handler size ceiling**: ~300 lines as a soft cap, ~500 lines hard cap. The 1,069-line PUT handler in `modify/route.ts` is the clearest red flag in the diff and predates this window in spirit. Each PUT route should compose a small number of named helpers that each do one thing.
- **Shared serialization module**: lift `cleanText`, `memberName`, `serializeDate`, `serializeMember` out of the three modules that currently redefine them. Audit consistency depends on one definition.
- **Reusable Prisma `include` constants**: any include block used more than twice becomes a `cancellationRequestInclude satisfies Prisma.XxxInclude`. Drift between inline copies has bitten this codebase before.
- **No-op wrappers**: `booking-modify-permissions.ts` is a 13-line re-export module. After refactors, delete shells; don't leave them.
- **Wrap `request.json()` in try/catch** at the start of every API route so malformed bodies return 400, not 500. Add a lint rule if possible.

## PR review template

Propose a `.github/PULL_REQUEST_TEMPLATE.md` checklist:

- [ ] New emails registered in `EMAIL_AUDIT_DEFAULTS` and have a dedicated admin preference key
- [ ] New admin routes use `requireAdmin`-style 401/403 split
- [ ] New tunable settings have a panel under `/admin/setup` or `/admin/notifications`
- [ ] New Stripe-touching code has idempotency key, durable retry path, admin alert on terminal failure, and a partial-failure test
- [ ] New Prisma model follows naming conventions documented in `docs/ARCHITECTURE.md`
- [ ] New migration has CHECK constraints on invariants the code assumes
- [ ] `request.json()` wrapped in try/catch returning 400 on malformed bodies
- [ ] No tokens in URL paths without a redact rule
- [ ] Tests cover both happy path and one partial-failure path

## Observability

- **Sentry tag conventions**: tag every new feature area (`feature: membership-cancellation`, `feature: booking-edit`, `feature: payment-recovery`) so error volume is attributable.
- **Alert on stale queue depth**: PaymentRecoveryOperation rows older than 15 min and PENDING; WAITING_PAYMENT outbox ops older than 24h; PENDING booking change requests older than 7d.

## Public to private repo handoff

- This audit is committed to the public repo under `docs/reviews/2026-05-24/`. When the sync to the private Tokoroa repo happens, drag the same folder across.
- The GitHub issues opened on the public repo will not transfer; recreate the equivalent set on the private repo after the sync.
- Re-run the same five tracks on the private repo, focusing on the deltas the private repo adds (chapter/club-specific code, deployment config, secret handling). Use this `06-best-practices.md` as the review template for the private pass.
