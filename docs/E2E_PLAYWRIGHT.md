# Playwright E2E Suite

Browser end-to-end tests for the **Critical** journeys in
[`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md), driven against the
staging Docker Compose stack (`docker-compose.staging.yml`, compose project
`tacbookings-staging`) seeded with the base seed (`prisma/seed.ts`) followed by
the demo seed (`prisma/demo-seed.ts`).

## What is covered

| Spec | Matrix row | Journey |
| --- | --- | --- |
| `e2e/two-factor-login.spec.ts` | Global two-factor enforcement (Critical) | Forced TOTP enrollment on first login, recovery codes, protected-route gating for unverified sessions, wrong-code rejection, TOTP re-login, single-use recovery codes |
| `e2e/booking.spec.ts` | Create booking with capacity lock (Critical) | Member books a bed through `/book` (confirm-details gate → dates → guests → review → payment step); while payment is owed the booking holds **no** bed (issue #737 — only committed money reserves capacity); the same member cannot hold the same lodge night twice |
| `e2e/stripe-payment.spec.ts` | Stripe payment success/failure (Critical) | In-wizard step-4 card payment with Stripe test cards: `4242…` confirms the booking and the paid booking occupies its beds; `4000 0000 0000 0002` declines and leaves it payable. **Skips unless genuine Stripe test-mode keys are configured** |

Not covered yet (follow-ups): email-code two-factor enrollment (needs an SMTP
capture container), waitlist/refund/Xero journeys, admin-role journeys.

## Running locally

```bash
cp .env.staging.example .env.staging   # once; adjust ports if taken
npm run test:e2e                       # prepare stack + run suite
```

`npm run test:e2e` (via `scripts/e2e-stack.sh`) does the following:

1. Starts the staging compose Postgres (host port `STAGING_POSTGRES_PORT`,
   default 5433 — **never** the production 5432).
2. Drops and recreates the `public` schema, then runs `prisma migrate deploy`,
   the base seed, and the demo seed, so every run starts from a known state.
   It then enables the global two-factor module
   (`e2e/setup/enable-two-factor-module.ts`) — a fresh database defaults it
   off, and the two-factor journey needs enforcement on.
3. Builds (unless `E2E_SKIP_APP_BUILD=1`) and starts the staging app on
   `STAGING_HTTP_PORT` (default 3001), waiting for `/api/health/ready`.
4. Runs `playwright test` with `E2E_BASE_URL` pointed at the staging app.

Other entry points:

```bash
npm run test:e2e:prepare   # stack + fresh database only
npm run test:e2e:run       # suite only (stack already prepared)
npm run test:e2e:run -- --ui               # Playwright UI mode
npm run test:e2e:run -- e2e/booking.spec.ts # one spec
npm run test:e2e:down      # stop the stack and delete its volumes
```

First-time setup: `npx playwright install chromium` (CI uses `--with-deps`).
The HTML report lands in `playwright-report/`; traces and screenshots for
failures land in `test-results/`.

The suite is serial (one worker) on purpose: specs assert on lodge capacity
and share seeded personas, so they must not interleave.

## Environment

Configuration comes from `.env.staging` (override the path with
`E2E_ENV_FILE`). Keep placeholder provider keys — the suite never needs live
providers, and `scripts/e2e-stack.sh` refuses to run if it sees `sk_live`/
`pk_live` Stripe keys.

- `E2E_BASE_URL` — target app (default `http://localhost:$STAGING_HTTP_PORT`).
- `E2E_DEMO_PASSWORD` — only if the demo seed ran with a custom
  `DEMO_SEED_PASSWORD`.
- Personas: the suite signs in as `alice@demo.alpineclub.test` (PAID
  subscription; books and pays) and `bob@demo.alpineclub.test` (drives
  two-factor enrollment). TOTP secrets and recovery codes captured during
  enrollment are stored under `e2e/.auth/` (gitignored) and cleared at the
  start of each run.
- Stay dates are computed relative to today (Monday–Wednesday windows at least
  three weeks out). The base seed's seasons cover Jun–Sep 2026 and Nov
  2026–Mar 2027; a run whose windows fall in a season gap fails loudly at the
  season assertion — extend the seeded seasons if that happens.

## Enabling the Stripe payment specs

The Payment Element requires a genuine Stripe **test-mode** account; the
payment specs skip when the keys look like placeholders.

- Locally: put real `sk_test_…` / `pk_test_…` keys in `.env.staging`
  (`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) and rerun
  `npm run test:e2e` (the publishable key is baked into the app image at build
  time, so the app must be rebuilt).
- CI: add `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_PUBLISHABLE_KEY`
  repository secrets. The workflow refuses live keys.

## CI

`.github/workflows/e2e.yml` runs the suite on PRs and pushes to `main`. It is
**non-blocking** (`continue-on-error: true`) while the suite beds in — a red
E2E job does not fail the workflow. Check the job log and the uploaded
`playwright-report` artifact when it goes red. Promote it to a required gate
by removing `continue-on-error` once it has proven stable.

## Safety

- The stack is the isolated `tacbookings-staging` compose project with its own
  Postgres volume. The scripts never touch port 5432 or the production compose
  project.
- No live providers: Stripe stays in test mode, email/SES stays unconfigured
  (failed sends are recorded by the app's email outbox, which is expected on
  staging), Xero and cron stay disabled.
