# Deployment Reference

This guide describes the AlpineClubBookingsNZ production deployment shape. It is a
reference for operators adapting the project to their own infrastructure.

Do not reuse another club's credentials, domains, payment accounts, accounting
tenants, email identities, Sentry projects, or database backups in a fork.
Create your own service accounts and secrets.

## Target Architecture

- Ubuntu 24.04 host with Docker and Docker Compose
- Caddy reverse proxy on ports 80 and 443
- PostgreSQL 16 in Docker
- Next.js app and migration images built by GitHub Actions and pulled from GHCR
- Optional S3-compatible storage for PostgreSQL backups
- Stripe, Xero, SES, and Sentry configured through environment variables

Production Compose services:

- `postgres` - database
- `app` - cron leader and warm fallback web upstream
- `app_blue` / `app_green` - web-only blue/green slots
- `caddy` - public reverse proxy and health-aware upstream routing
- `migrate` - explicit Prisma migration runner

## Prerequisites

- A host sized for your traffic and runtime memory needs
- DNS control for your deployment domain
- Docker and Docker Compose installed
- GHCR read access for private image packages, unless the image packages are
  public
- A PostgreSQL backup and restore plan
- Stripe live or test account, depending on environment
- Xero app or demo tenant, depending on environment
- SES or another SMTP-compatible transactional email service
- Sentry project, if source maps and runtime error reporting are desired

## Environment

Start from `.env.example` and the configuration reference:

```bash
cp .env.example .env
```

See `CONFIGURATION.md` for every supported environment variable and
`config/club.json` field.

Generate unique secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET and NEXTAUTH_SECRET
openssl rand -base64 24   # CRON_SECRET
openssl rand -base64 24   # DB_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The Node command produces a 64-character hex key suitable for Xero token
encryption variables.

Minimum production categories:

- Database: `DATABASE_URL`, `DB_PASSWORD`
- Auth: `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`
- Public app: `DOMAIN`, `NEXT_PUBLIC_CONTACT_EMAIL`
  `DOMAIN` is the root public host consumed by `Caddyfile` through the
  `{$DOMAIN}` placeholder. Caddy derives `www`, `bookings`, and `dashboard`
  subdomains from that value.
- Modules: optional modules are database-backed in `ClubModuleSettings` and
  controlled from Admin > Modules after first login. No `FEATURE_*`
  environment variables are supported or read by the app.
- Stripe: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`
- Xero: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`,
  `XERO_ENCRYPTION_KEY`, optional `XERO_WEBHOOK_KEY`. This single connection
  serves bookings, payments, subscriptions, and the finance dashboard. Configure
  the Xero app with the exact operational scopes requested by
  `src/lib/xero-config.ts`: `openid`, `profile`, `email`,
  `accounting.contacts`, `accounting.invoices`, `accounting.payments`,
  `accounting.settings.read`, `accounting.reports.profitandloss.read`,
  `accounting.reports.balancesheet.read`,
  `accounting.reports.banksummary.read`, and `offline_access`. Do not grant the
  stale generic all-reports scope; reconnect Xero from `/admin/xero` after
  changing allowed scopes so new tokens carry the granular report scopes.
- Email: `SMTP_HOST`, `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`,
  `AWS_SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`, `SES_SNS_TOPIC_ARN`
- Cron and backups: `CRON_SECRET`, `BACKUP_*`, optional
  `AUDIT_ARCHIVE_DATABASE_URL`
- Admin health: optional `CRON_LEADER_RUNTIME_STATUS_URL` when the cron leader
  is not reachable from web containers at
  `http://app:3000/api/deploy/runtime-status`
- Observability: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`

Do not commit `.env` files or production secrets.

## GitHub Container Registry

GitHub Actions publishes production images after CI passes on `main`:

```text
ghcr.io/<owner>/alpineclubbookingsnz-app:<commit-sha>
ghcr.io/<owner>/alpineclubbookingsnz-migrate:<commit-sha>
```

If those packages are private, log in to GHCR once on the production host as
the same Linux user that runs deployments. Use a token with only
`read:packages` access:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <owner> --password-stdin
```

Do not store that token in the repository or `.env`.

## First Bootstrap

From the target host:

```bash
git clone https://github.com/<owner>/AlpineClubBookingsNZ.git AlpineClubBookingsNZ
cd AlpineClubBookingsNZ
cp .env.example .env
cp config/club.example.json config/club.json
# edit .env with your own values
# edit config/club.json with your club identity, beds, and rates
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose up -d --build app app_blue app_green caddy
docker compose ps
```

Create or seed accounts only for the intended environment. The first admin
from `prisma/seed.ts` is controlled by `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` (optionally `SEED_ADMIN_FIRST_NAME` and
`SEED_ADMIN_LAST_NAME`), and the shared lodge kiosk account by
`SEED_LODGE_PASSWORD`. The seeded admin can log in immediately and is forced
to change password on first login; change all seed credentials before any
shared environment is exposed. The seed is create-if-missing throughout, so
re-running it against an existing database changes nothing; committee and
chore placeholders are only inserted when those tables are empty.

## Routine Production Deploy

The supported AlpineClubBookingsNZ deploy path is:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The script snapshots the resolved `origin/main` commit into a clean deployment
workspace, selects the matching GHCR image tags, copies the environment file,
preserves Caddy upstream state, then re-enters itself with
`--internal-blue-green-deploy` to run the blue/green deployment engine before it
fast-forwards the clean checkout after success.

For a fork, set `GHCR_APP_IMAGE_REPOSITORY` and
`GHCR_MIGRATE_IMAGE_REPOSITORY` if your image names differ from the defaults.

The internal deployment engine in the same script:

- pulls the app and migration images for the resolved commit SHA
- skips local Docker builds when `APP_IMAGE` and `MIGRATE_IMAGE` are supplied
- validates pending migrations against the blue/green migration policy
- runs Prisma migrations through the `migrate` service
- starts the inactive color slot with `CRON_ENABLED=false`
- waits for `/api/health/ready`
- updates Caddy upstream routing
- verifies the public domain is serving the target runtime through
  `/api/deploy/runtime-status`, authenticated with the existing `CRON_SECRET`
  as the `x-cron-secret` header
- drains the previous slot

If `APP_IMAGE` and `MIGRATE_IMAGE` are not supplied, the internal engine keeps
the old local-build path for bootstrap, staging, and recovery work.

## Public Rate Limits And Proxy Headers

Public route rate limits are process-local sliding windows keyed by
`getClientIp()` in `src/lib/rate-limit.ts`. This is acceptable for the supported
production shape because Caddy is the only public listener and routes traffic to
one active web slot at a time.

During a blue/green deployment, the old slot can still serve requests while the
configured drain window expires. Rate-limit counters are not shared between the
old and new slots, so public abuse controls can be temporarily split across both
runtimes during that drain. Do not run multiple publicly routed app replicas
long-term unless the in-memory limiter is replaced with a shared store.

The app trusts proxy-derived client IP headers only under that Caddy boundary.
`getClientIp()` uses the rightmost `X-Forwarded-For` value, which is the peer
Caddy appended closest to the app container, then falls back to `X-Real-IP`.
Do not expose app containers directly to the Internet or through another proxy
that preserves attacker-supplied `X-Forwarded-For` values without appending its
own trusted peer address.

## Migration Safety

Read `docs/BLUE_GREEN_MIGRATION_POLICY.md` before deploying schema changes.
Migrations must be compatible with old and new app versions during cutover.

Potentially breaking migrations require explicit operator acknowledgement with:

```bash
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="..."
```

Use this only with a written rollback and lock-impact plan.

## Staging

Use staging for browser checks, accessibility review, and integration rehearsal.

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
```

See `docs/STAGING_ACCESSIBILITY.md` for route coverage and Lighthouse guidance.
Use Stripe test mode, Xero demo credentials, non-production email settings, and
synthetic data.

## Backups

The app can run scheduled PostgreSQL dumps to S3-compatible storage when
`BACKUP_ENABLED=true`. Configure:

- `BACKUP_S3_BUCKET`
- `BACKUP_S3_REGION`
- `BACKUP_S3_ACCESS_KEY_ID`
- `BACKUP_S3_SECRET_ACCESS_KEY`
- `BACKUP_RETENTION_DAYS`
- `BACKUP_CRON_SCHEDULE`
- optional `BACKUP_RESTORE_VALIDATION_URL`

Do not treat local backup files as durable. The production Docker service runs
with `read_only: true` and mounts `/tmp` as tmpfs, so `/tmp/tacbookings-backups`
is RAM-backed and is wiped whenever the app container is recreated, including
routine blue/green deploys. If `BACKUP_ENABLED=true` but `BACKUP_S3_BUCKET` is
not configured, the job no longer reports healthy: the dump is marked
`backup-not-durable`, the cron run records `FAILURE`, and the Sentry monitor
check-in is sent as an error. A healthy scheduled backup requires S3 upload and
readback verification.

Operators should also keep provider-level snapshots or equivalent independent
backups. Test restore procedures before relying on backups.

## Webhooks

Configure webhook endpoints for the deployed domain:

- Stripe: `/api/webhooks/stripe`
- Xero: `/api/webhooks/xero`
- SES SNS: `/api/webhooks/ses-sns`

Keep webhook secrets in `.env`. Rotate them if they are exposed.

Subscribe the Stripe endpoint to these event types:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `payment_intent.requires_action`
- `payment_intent.processing`
- `setup_intent.succeeded`
- `setup_intent.setup_failed`
- `setup_intent.canceled`
- `charge.refunded`

If Stripe webhook delivery was missed while the endpoint, DNS, TLS, or
`STRIPE_WEBHOOK_SECRET` was wrong, fix the endpoint first, then use Stripe
Dashboard > Developers > Webhooks > the configured endpoint > Event deliveries
to resend failed events. Verify the event appears in webhook logs and the
affected booking/payment state before retrying operator actions. Do not repair
Stripe state by editing payment rows directly; unresolved payment-intent cleanup
is replayed by the payment recovery cron.

## Cron Schedule

The supported Docker Compose deployment runs scheduled work inside the `app`
cron-leader container when `CRON_ENABLED=true`. Blue/green web slots set
`CRON_ENABLED=false` and do not schedule jobs. The secured POST endpoints remain
available for the internal scheduler, manual operator retries, and custom
non-Compose deployments that intentionally use an external scheduler. Auth is
the `x-cron-secret` header set to `CRON_SECRET`.

The full schedule and all job names live in `docs/ARCHITECTURE.md`. Keep that
table and the cron registry in `src/lib/admin-cron-health.ts` as the source of
truth. The public POST endpoints are:

| Endpoint | Task(s) | Typical cadence | Recorded `CronJobRun.jobName` |
| -------- | ------- | --------------- | ----------------------------- |
| `POST /api/cron` | General cron cycle: pending booking confirmation, group-settlement reaper, pre-arrival reminders, booking-request retention purge, quote-expiry reminders, and school attendee confirmations. | Every 3 hours in the cron leader. | `confirm-pending`, `group-settlement-reaper`, `pre-arrival-reminders`, `purge-booking-requests`, `quote-expiry-reminders`, `school-attendee-confirmations` |
| `POST /api/cron/payments?task=recovery` | Durable Stripe payment recovery, expired Internet Banking hold release, and stale `WAITING_PAYMENT` Xero outbox reaping. | Every 15 minutes in the cron leader. | `payment-recovery` |
| `POST /api/cron/xero?task=memberships` | Optional Xero-backed membership status refresh. | Daily when `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=true` and the Xero module is effectively enabled. | `xero-membership-refresh` |
| `POST /api/cron/xero?task=outbox` | Process queued outbound Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-outbox` |
| `POST /api/cron/xero?task=retries` | Replay failed retryable Xero operations. | Every 15 minutes when the Xero module is effectively enabled. | `xero-operation-replay` |
| `POST /api/cron/xero?task=inbound` | Reconcile inbound Xero invoice, payment, contact, and membership state. | Every 15 minutes when the Xero module is effectively enabled. | `xero-inbound-reconcile` |
| `POST /api/cron/xero?task=backfill` | Backfill historical Xero object links; the default runner also performs link cleanup with this task. | Daily when the Xero module is effectively enabled. | `xero-link-backfill`, `xero-link-cleanup` |
| `POST /api/cron/xero?task=link-cleanup` | Deactivate stale canonical Xero object links. | Daily when the Xero module is effectively enabled. | `xero-link-cleanup` |
| `POST /api/cron/xero?task=report` | Send the Xero reconciliation report. | Daily when the Xero module is effectively enabled. | `xero-reconciliation-report` |
| `POST /api/cron/issue-reports` | Redact expired issue-report sensitive data. | Daily. | Not recorded |

Without `/api/cron/payments?task=recovery` running on a regular schedule,
abandoned zero-dollar batch edits leave PaymentIntents held in Stripe
indefinitely. The `/api/health` detailed report surfaces a stale recovery
queue when any `PaymentRecoveryOperation` row has been `PENDING` for more
than 15 minutes. Each cron tick also sends an admin alert (re-using
`sendAdminPaymentFailureAlert`) when the queue contains a row that has
been pending for more than 30 minutes, with a one-hour cooldown to avoid
storming the inbox.

## Health Checks

Use these endpoints for smoke tests and load-balancer readiness:

```bash
curl -fsS https://your-domain.example/api/health
curl -fsS https://your-domain.example/api/health/ready
```

`/api/health/ready` is the readiness endpoint used by blue/green cutover.
Setup readiness and `/admin/setup` report optional modules as layered state:
`.env` capability, Admin Modules activation, and the resulting effective state.
The blue/green deploy script still validates explicit `.env` capability values
before deployment; Admin Modules do not replace that safety check.

## Rollback

Preferred rollback is to route Caddy back to the previous healthy color while it
is still running. If schema changes have already applied, rollback must respect
the migration policy and any compatibility constraints in the migration PR.

Keep deploy logs, the target commit SHA, migration output, and health-check
results with the release record.
