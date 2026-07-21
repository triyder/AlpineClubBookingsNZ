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

## Connection pool sizing

Each app container's Prisma pool size is the `connection_limit` in its
`DATABASE_URL` (in `docker-compose.yml`). Prisma treats it as a hard ceiling,
and advisory-lock waiters hold their connection while blocked — so an
undersized web pool lets a single-lodge booking burst exhaust it and stall
unrelated requests. The defaults are sized for ~100 concurrent users against
Postgres `max_connections=30`:

| Service | Role | `connection_limit` |
| --- | --- | --- |
| `app_blue` / `app_green` | web slots | 10 each |
| `app` | cron leader + warm fallback web | 5 |
| `migrate` | deploy-window migrations | 2 |

Postgres keeps 3 superuser-reserved slots, leaving **27 usable**. The worst
case is a blue/green handover (both web slots briefly live) that overlaps a
migration:

```
app_blue(10) + app_green(10) + app(5) = 25 steady
                                 + migrate(2) = 27  <=  27 usable
```

Steady state (one active web slot + cron leader) is far lower. If a fork needs
more web headroom, **raise Postgres `max_connections` to 40 and its `mem_limit`
to ~768m** (in the `postgres` service) rather than squeezing these per-pool
ceilings past the 27-usable budget — over-committing `connection_limit` beyond
`max_connections` surfaces as `FATAL: sorry, too many clients` under load. Keep
the arithmetic (sum of all live pools ≤ usable connections) whenever you change
a pool size or the replica count.

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
- Public app: `DOMAIN`.
  `DOMAIN` is the root public host consumed by `Caddyfile` through the
  `{$DOMAIN}` placeholder. Caddy derives `www`, `bookings`, and `dashboard`
  subdomains from that value.
- Modules: optional modules are database-backed in `ClubModuleSettings` and
  controlled from Admin > Modules after first login. No `FEATURE_*`
  environment variables are supported or read by the app.
- Stripe: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`
- Xero: **no env vars** (#2079). The Xero client id/secret, webhook key, and
  token-encryption key are captured **in-app** (Admin > Integrations, Full Admin
  only) and stored encrypted; the redirect URI derives from `NEXTAUTH_URL`. This
  single connection serves bookings, payments, subscriptions, and the finance
  dashboard. Configure the Xero app with the exact operational scopes requested
  by `src/lib/xero-config.ts`: `openid`, `profile`, `email`,
  `accounting.contacts`, `accounting.invoices`, `accounting.payments`,
  `accounting.settings.read`, `accounting.reports.profitandloss.read`,
  `accounting.reports.balancesheet.read`,
  `accounting.reports.banksummary.read`, and `offline_access`. Do not grant the
  stale generic all-reports scope; reconnect Xero from `/admin/integrations`
  after changing allowed scopes so new tokens carry the granular report scopes.
  Any legacy `XERO_*` credential env vars still present are ignored and flagged
  in setup readiness — see the **Upgrade: DB-only provider credentials** runbook
  below.
- Email: `SMTP_HOST`, `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`,
  `AWS_SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`, `SES_SNS_TOPIC_ARN`. `EMAIL_FROM` is
  the only email-identity env var (besides these transport secrets): it is the
  envelope / Return-Path sender and must be a provider-verified (SES) address.
  Email identity — from display name, support address, and contact-form
  recipient — is admin-managed DB-first from **Admin > Email Messages**
  (`EmailMessageSetting`); the former `EMAIL_FROM_NAME`, `SUPPORT_EMAIL`,
  `CONTACT_EMAIL`, and the dead `NEXT_PUBLIC_CONTACT_EMAIL` env vars were removed
  (#1986). **Upgrade note:** a deployment that previously relied on the
  `CONTACT_EMAIL` env var to route the contact form must set the DB
  `contactEmail` (Admin > Email Messages); if unset it falls back to the support
  address per the existing precedence, so there is no hard break.
- Cron and backups: `CRON_SECRET`, `BACKUP_*`, optional
  `AUDIT_ARCHIVE_DATABASE_URL`
- Bootstrap provisioning (optional): `CONFIG_BUNDLE_IMPORT_PATH` — path to a
  config-transfer bundle applied non-interactively on boot **only** when the
  database is empty of non-seed configuration. See "Config Bundle Auto-Import On
  Boot (DR / clone)".
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
# edit .env with your own values
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose up -d --build app app_blue app_green caddy
docker compose ps
```

To validate the production image alone (without Compose), build it locally:

```bash
docker build -t tacbookings:local .
```

Club identity, capacity, age tiers, seasons, and rates are configured **in the
database**, not in a file. After the migrate/seed steps, sign in as the seeded
admin and complete configuration at `/admin/setup` (identity, lodges/capacity,
seasons/rates, email, Stripe, Xero). Optionally run `npm run setup:wizard`
against the migrated database to bootstrap the club identity, capacity, and age
tiers from the CLI — it writes those database settings rows (no `config/club.json`
is written). `config/club.json` remains an optional seed/fallback only: copy
`config/club.example.json` to `config/club.json` and edit it if you want to pin
a boot-time fallback, but it is no longer required.

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

### Expand then contract (multi-lodge)

Some features ship as a two-step expand/contract pair: an expand release adds
nullable columns and backfills, and a later contract release tightens them
(`NOT NULL`, dropped superseded columns, added unique indexes). The
multi-lodge feature is the current example — its `lodgeId` columns landed
nullable and backfilled, with the tightening deferred.

**Do not run the multi-lodge contract release until the expand release is
fully cut over and the old (pre-lodge) app colour is completely drained.** A
draining old colour can still write `NULL`-`lodgeId` rows, which the `NOT NULL`
migration will reject, and the runtime keeps null-tolerant compatibility
branches alive until the contract release lands. Follow
`docs/multi-lodge/contract-release.md` for the item list, backfill
verification queries, sequencing, and the ledger entries that release needs;
each contract migration must name its `previous_expand_release` in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

## Config Self-Heal On Boot

A routine production deploy runs `prisma migrate deploy` **only**. The seed
(`prisma/seed.ts`) does **not** run on an upgrade, and a SQL migration **cannot
read `config/club.json`** — so any config value the DB is expected to hold
cannot be backfilled by the migration or the seed on a live upgrade.

To close that gap the app runs a **boot-time config self-heal**
(`src/lib/config-self-heal.ts`, invoked from `src/instrumentation.node.ts`).
On every Node process start it walks a registry of self-heal steps and, for each
registered setting, copies the current **effective `config/club.json` value**
into the DB — using one of two presence rules, depending on whether the migration
that enabled the setting added a whole **row** or a single **column**. Properties:

- **Never overwrites admin intent.** Two write shapes, both guarded so a value an
  admin (or an earlier boot) already set is never touched:
  - **Row-level create-if-absent** — for a setting that owns its table/singleton
    row (e.g. the club identity row). The step writes only when the row is
    **absent** and leaves an existing row — including one an admin deliberately
    left partially null — completely untouched (`update: {}`).
  - **Column-level backfill** — for a **new nullable column** added to an existing
    singleton row long after that row was created (e.g.
    `ClubIdentitySettings.facebookUrl`, C5 #1984). A row-level check would skip
    every install whose row predates the column, so presence is keyed on the
    **column** instead: the step create-if-absent-upserts the row, then fills the
    column with an atomic `updateMany` scoped to `WHERE facebookUrl IS NULL`. It
    can therefore only ever populate a **still-null** column and never clobbers an
    admin-set value or a concurrent booter's write. A null on such a
    later-added column cannot be admin intent — the column did not exist when any
    prior admin edit was made.
- **Idempotent.** A healthy install re-checks and writes nothing on later boots.
- **Blue/green-safe.** When both slots boot at once, the second writer's
  unique-constraint conflict (Prisma `P2002`) is treated as already-present, so
  exactly one row is populated and no error surfaces.
- **Best-effort.** Self-heal runs regardless of `CRON_ENABLED` and can never
  block or fail startup; a step failure is logged (`scope: "config-self-heal"`)
  and boot continues.
- **Fallback-guarded.** Healing runs **only when the effective config came from
  a valid primary `config/club.json`** (loader provenance `"primary"`). If the
  primary is missing, unreadable, or malformed, the app boots on the
  `club.example.json` identity or the hard-coded safe default — and the
  self-heal **skips every step** rather than freezing that placeholder identity
  (or safe-default capacity and rates) into the create-if-absent DB rows. Those
  rows are DB-first authoritative and are never overwritten, so one bad boot
  would otherwise strand the site on `"Example Mountain Club"` until an admin
  edit or DB surgery. A skipped run logs a warning
  (`scope: "config-self-heal"`) naming the provenance; **it self-repairs
  automatically on the next boot** once a valid primary config is present. Every
  step (including the capacity / age-tier / rate steps later collapse children
  register) inherits this guard automatically.

This mechanism — not migration/seed backfill — is what lets later config
"collapse" changes remove a file/env fallback without stranding an existing
deployment: the DB is already populated with the club's real value before the
fallback is dropped. New settings register their own step in `SELF_HEAL_STEPS`.
Registered steps:

- **`club-identity-settings`** — backfills the club identity
  (`ClubIdentitySettings`) from `config/club.json`.
- **`club-identity-facebook-url`** (#1984) — column-level backfill of the
  `facebookUrl` column added after the identity row existed.
- **`age-tiers`** (#1983) — table-empty presence + one atomic create-if-absent
  row per effective-config tier (mirroring `prisma/seed.ts`'s tier seed); an
  admin-edited or pruned tier set is never touched. Heals **tiers only** —
  nightly rates live independently in `MembershipTypeSeasonRate` (#1930, E4).
  `src/lib/policies/age-tier.ts` reads age tiers DB-only at runtime; its
  hard-coded 4-tier default is only the last-resort net for an empty table.
- **`lodge-capacity`** (#1982) — backfills the default lodge's
  `LodgeSettings.capacity` from the `config/club.json` bed total (column-level:
  it fills a null `capacity`, create-if-absent, and never overwrites an
  admin-set value), gated so it only fires when the lodge would otherwise
  resolve to capacity 0. This is what keeps a Bed-Allocation-off default lodge
  from dropping to capacity 0 — and refusing all bookings — after the runtime
  `club.json` capacity fallback was removed.

For a deliberate two-phase deploy, or to heal a cold database out-of-band
without a restart, run the same routine manually:

```bash
npm run config:self-heal
```

It prints, per registered setting, whether the row was `healed`,
`already-present`, or `failed`, and exits non-zero if any step failed. If the
effective config is a fallback (no valid primary `config/club.json`), it writes
nothing, prints the provenance and the remediation ("fix `config/club.json`,
then rerun"), and **exits non-zero** — an out-of-band run that silently no-oped
would hide the misconfiguration.

## Config Bundle Auto-Import On Boot (DR / clone)

To seed a fresh instance — disaster recovery, or standing up a replacement /
clone — from a known-good configuration instead of hand-configuring it, drop the
club's exported **config-transfer bundle** on disk and point
`CONFIG_BUNDLE_IMPORT_PATH` at it. On the next Node boot — **after** migrations,
the base seed, and the C2 self-heal — the app applies that bundle
**non-interactively**, through the same validated import pipeline the admin
Export & Import page uses (`src/lib/config-transfer/bootstrap-import.ts`,
implementing ADR-003).

The whole provisioning flow becomes:

```text
deploy env + bundle file  →  prisma migrate deploy  →  base seed  →  boot auto-import  →  operational site
```

### Placement and enabling

- Export the source club's bundle from **Admin → Setup & Configuration →
  Export & Import** (tick the categories to carry; door codes are opt-in).
- The app containers run with a **read-only root filesystem** and, out of the
  box, mount only the `image_uploads` volume — there is no pre-existing
  `config/` mount. Bind-mount a host directory containing the bundle into the
  app services (read-only), and add the env var to the shared
  `x-app-environment` anchor so **all** replicas (`app`, `app_blue`,
  `app_green`) see the same file and the same setting:

  ```yaml
  # docker-compose.yml (or an override file)
  x-app-environment: &app-environment
    # ... existing entries ...
    CONFIG_BUNDLE_IMPORT_PATH: ${CONFIG_BUNDLE_IMPORT_PATH:-}

  x-app-service: &app-service
    # ... existing entries ...
    volumes:
      - image_uploads:/app/public/images
      - ./config-bundle:/app/config-bundle:ro   # bundle drop directory
  ```

  Then on the host:

  ```bash
  mkdir -p config-bundle
  cp /path/to/club-bundle.zip config-bundle/
  echo 'CONFIG_BUNDLE_IMPORT_PATH=/app/config-bundle/club-bundle.zip' >> .env
  docker compose up -d
  ```

  The path is the **in-container** path (`/app/config-bundle/club-bundle.zip`
  in this example). Because every replica boots the import step, the file must
  be readable by all of them — a shared bind mount on the `x-app-service`
  anchor guarantees that; the in-lock re-check (below) guarantees only one
  replica actually applies. The variable is unset by default; leaving it unset
  is a silent no-op.
- The file is **operator-controlled deployment configuration** but its bytes are
  treated as **untrusted** — full structural validation, resource caps, the
  secret/auth/member-coupling allowlist, and per-field Prisma-DMMF type checks
  all apply (a bundle can never carry secrets, auth material, members, or
  transactional data). The file is also `stat`ed before it is read: an
  oversized (> 50 MB bundle cap) or non-regular file is refused without being
  loaded into memory.

### The empty-target guarantee (fail closed)

The import applies **only when the database is empty of non-seed configuration**
— the pristine post-seed state with **no operator footprint**, defined as the
absence of ALL SIX of these signals:

1. no config bundle has ever been imported (interactive or bootstrap),
2. no bookings exist,
3. no members exist beyond the seeded system accounts (admin + lodge kiosk),
4. the setup wizard was never marked finished,
5. the setup wizard was never even started — no completed or skipped wizard
   steps (a club configured through `/admin/setup` without pressing "finish"
   is still configured), and
6. no audit-log row has a member actor (every admin configuration edit —
   direct editors included — audits with the admin's member id; only
   `system:`-prefixed synthetic actors and actor-less system rows are ignored).

If **any** of those is present, the import is **refused and nothing is written**
— a file dropped on disk can never overwrite a live or already-configured club,
whether it was configured by imports, bookings, members, the wizard, or direct
admin edits. A malformed / tampered / oversized bundle, an unreadable
`CONFIG_BUNDLE_IMPORT_PATH`, a probe query error, or any apply failure also
refuses and leaves the database untouched. The apply runs in a single atomic
transaction — with the emptiness probe **re-run inside the import lock** before
anything is written, and the idempotence marker committed in the same
transaction — so a mid-apply failure rolls back completely and two concurrent
boots can never double-apply. **Boot always continues**; a bootstrap bundle can
never block or crash startup.

One refusal deserves a special note: the seed creates key-weak defaults (the
default induction template, the example chore templates), so a bundle whose
source club **renamed** those defaults produces rename candidates that need a
human decision, and the bootstrap aborts with `refused-invalid` (nothing
written) — see the rename-abort log below. The fallback is the interactive
import (**Admin → Setup & Configuration → Export & Import**), where the renames
are resolved by hand.

Unlike the self-heal, this import is **not** gated on config provenance: the
bundle is the config source in a DR restore where `config/club.json` may be
absent, so it runs regardless of `clubConfigSource`. The pre-apply `pg_dump`
backup is the **one** ADR-002 safeguard waived here (an empty database has
nothing to protect); every other safeguard applies.

### Expected logs (`scope: "config-bootstrap-import"`)

- **Applied** (fresh empty target — exactly ONE replica logs this):
  `Config bundle auto-imported on boot: created N, updated M, unchanged K.`
  A `configuration.bootstrap_imported` audit row is written in the same
  transaction (system/deploy actor, bundle sha256, outcome); the admin audit
  log shows the actor as "System".
- **Multi-replica first boot** (INFO — expected, not an error): the compose
  stack boots `app`, `app_blue`, and `app_green` near-simultaneously; every
  replica probes, one wins the import lock and applies, and each **losing
  replica** logs
  `Config bundle auto-import refused: another writer configured the target
  while this import was being prepared (…). On a multi-replica boot this is the
  expected outcome for every replica that did not win the race. Nothing was
  written by this replica; boot continues.`
  (A replica that boots after the winner committed logs the steady-state
  refusal below instead. Either way: one "auto-imported" line total, calm INFO
  everywhere else.)
- **Steady state** (later boots with the variable still set, INFO — expected,
  not an error): `Config bundle auto-import refused: a config bundle was already
  auto-imported on a prior boot; the target is configured (steady state).`
  Steady-state boots do **zero file I/O** — the probe refuses before the bundle
  file is even statted.
- **Non-empty target** (WARN):
  `Config bundle auto-import refused: target already has … ; …` (or the
  wizard/member-actor variants of the six signals above).
- **Rename abort** (ERROR, `refused-invalid` — see the note above):
  `Config bundle auto-import refused: N row(s) need an interactive rename
  decision, which cannot be made non-interactively: induction-template "…", … .
  This can happen when the source club renamed seed-created defaults (e.g. the
  induction template or example chore templates). Import the bundle through
  Admin → Setup & Configuration → Export & Import instead, and resolve the
  renames there. Nothing was written.`
- **Bad bundle / path** (ERROR or WARN): a validation-error, oversized-file,
  unreadable-path, or apply-failure message — always stating that nothing was
  written and boot continues.

Because a successful import commits the `configuration.bootstrap_imported`
marker atomically with the config writes, the step is **idempotent and
race-safe**: leaving `CONFIG_BUNDLE_IMPORT_PATH` set across restarts simply
logs the calm steady-state refusal (with no file I/O) on every subsequent boot.
You may unset it once the site is up.

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

`BACKUP_RETENTION_DAYS` prunes only the local backup files; it does not delete
objects already uploaded to S3. Enforce S3 retention with a bucket lifecycle
policy (or equivalent object-expiry rule) so uploaded dumps do not accumulate
indefinitely.

Operators should also keep provider-level snapshots or equivalent independent
backups. Test restore procedures before relying on backups.

## Webhooks

Configure webhook endpoints for the deployed domain:

- Stripe: `/api/webhooks/stripe`
- Xero: `/api/webhooks/xero`
- SES SNS: `/api/webhooks/ses-sns`

Stripe and SES webhook secrets are env-configured (`STRIPE_WEBHOOK_SECRET`,
`SES_SNS_TOPIC_ARN`); rotate them if exposed. The **Xero** webhook key is **not**
an env var since #2079 — it is captured in-app (Admin > Integrations) and stored
encrypted, and the `/api/webhooks/xero` route resolves it from there and stays
**fail-closed** (a missing/unreadable key rejects every delivery, it never
accepts).

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

## Provider credentials: DB-only upgrade & auth-secret rotation (#2079)

### Upgrade: DB-only provider credentials

Since #2079 provider credentials (Xero here; Stripe/Google/Backup in later
releases) are stored **only** in the encrypted `IntegrationCredential` table and
captured in-app under **Admin > Integrations** (Full Admin only). Bootstrap-class
config (`AUTH_SECRET`, `DATABASE_URL`, `NEXTAUTH_URL`, SMTP/SES) is unchanged.

**What stops working at the upgrade** for a previously env-configured deployment
(e.g. an existing Xero-connected install):

- The old `XERO_ENCRYPTION_KEY` is no longer read, so the previously stored Xero
  OAuth tokens become **unreadable by design** (deliberately no silent key
  import). Xero surfaces a clean **"reconnect Xero"** state — no crash.
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` /
  `XERO_WEBHOOK_KEY` are ignored; setup readiness raises a warning naming the
  exact vars still present ("configured in-app now — re-enter there, then remove
  these from the environment").

**Re-entry order (per provider):**

1. Ensure `AUTH_SECRET` (or `NEXTAUTH_SECRET`) is strong (>= 32 chars, not the
   `.env.example` placeholder). Credential capture is **hard-blocked** on a weak
   secret; setup readiness shows a passive amber warning before you start.
2. Deploy the new release. Nothing fails at boot; readiness shows the legacy-env
   warnings and the Xero "reconnect" prompt.
3. Open **Admin > Xero > Setup** (the Integrations hub links here) and use the
   **Xero Credentials** section to re-enter the client id, client secret, and
   (optional) webhook key. Each write is Full-Admin only, encrypted at rest, and
   audited (metadata only); values are never displayed back. The wrapped
   token-encryption key is auto-generated on first use. (This interim entry form
   is superseded by the guided Xero setup wizard in a later release, C2/#2080 —
   the re-entry steps stay the same.)
4. Reconnect Xero (OAuth) so fresh tokens are stored under the new key.
5. Remove the now-ignored `XERO_*` credential env vars from the environment;
   the readiness warning clears.

**Expected downtime:** none at deploy. Xero-backed operations (sync, webhooks,
invoice/payment automation) pause between the upgrade and step 4 completing, and
resume once credentials are re-entered and Xero is reconnected. Because
production runs blue/green web slots plus a cron-leader, a wizard write in one
web slot is observed by the cron-leader within the credential cache TTL
(30–60s), no restart required.

### Auth-secret rotation runbook

Rotating `AUTH_SECRET`/`NEXTAUTH_SECRET` is a **planned maintenance event**, not
a casual refresh. Rotation drops, all at once:

- **all sessions** (everyone is signed out);
- **all 2FA enrolments and recovery-code hashes** — every member is forced back
  through two-factor enrollment on next sign-in. **Admin-lockout risk:** an admin
  who cannot immediately re-enroll (lost authenticator) can be locked out.
- **all stored provider credentials** (Xero client id/secret/webhook key) and the
  **wrapped Xero token-encryption key** — these fail GCM decryption afterwards
  and must be re-entered in-app; Xero must be reconnected (re-OAuth).

**Safe procedure:**

1. Announce the maintenance window to members and admins.
2. Before rotating, have at least one Full Admin **disable their 2FA** (so they
   can still sign in immediately after rotation), or confirm a break-glass access
   path.
3. Rotate the secret and redeploy.
4. Sign in, **re-enable/re-enroll 2FA** for admins first, then re-enter provider
   credentials (Admin > Integrations) and reconnect Xero.
5. Communicate to members that they must re-enroll 2FA on next sign-in.

**Security consequence (see `docs/SECURITY-ATTACK-SURFACE.md`):** because all
provider credentials are encrypted under key material derived from this one
secret, a database backup **plus** the auth secret is enough to decrypt every
stored credential. Production and staging/clones must therefore **never** share
an auth secret.

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
indefinitely. The admin `/api/admin/health` detailed report surfaces a stale
recovery queue when any `PaymentRecoveryOperation` row has been `PENDING` for
more than 15 minutes (the public `/api/health` report does not include this
signal). Each cron tick also sends an admin alert (re-using
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
