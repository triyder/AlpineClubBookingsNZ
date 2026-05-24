# Implementation Guide

This guide is the practical path for adapting AlpineClubBookingsNZ for another
club. Keep live provider credentials and real member data out of public forks,
CI, and local experiments.

## 1. Fork And Install

```bash
git clone https://github.com/<owner>/AlpineClubBookingsNZ.git
cd AlpineClubBookingsNZ
cp .env.example .env
cp config/club.example.json config/club.json
npm ci
npx prisma generate
npm run setup:check
```

Use Node.js 24 LTS and npm 11 or newer.

## 2. Configure Club Identity

Edit `config/club.json` first. This file controls:

- club name, short name, public URL, and support/contact emails
- sender display name and public social links
- bed or lodge capacity
- age tiers and integer-cent nightly rates

Keep all money values in cents. Keep booking dates as New Zealand date-only
lodge nights unless you intentionally rework the booking model.

For a guided config pass, run:

```bash
npm run setup:wizard
```

The wizard writes `config/club.json` only. Keep provider keys, OAuth secrets,
SMTP credentials, and deployment secrets in environment variables or your
deployment secret store.

Replace the deployment branding files in `public/branding/`:

- `logo.png`
- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The public `*.example.*` files are placeholders for forks and documentation.

## 3. Configure Local Environment

Set at least these values in `.env` before running a database-backed app:

- `DATABASE_URL`
- `DB_PASSWORD`
- `AUTH_SECRET`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `AUTH_TRUST_HOST`
- `CRON_SECRET`
- `SEED_ADMIN_EMAIL`
- `SEED_ADMIN_PASSWORD`

External integrations can stay disabled or use test/demo credentials while you
bring up the core app.

Feature flags are explicit strings:

```text
FEATURE_KIOSK=false
FEATURE_CHORES=false
FEATURE_FINANCE_DASHBOARD=false
FEATURE_WAITLIST=false
FEATURE_XERO_INTEGRATION=false
```

Only the literal value `true` enables a feature.
The env value is a deploy-time capability gate. After migrations run, admins can
activate or deactivate allowed optional modules at `/admin/modules`.

## 4. Bring Up A Local Database

For a Docker-backed local/staging-style setup:

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p alpineclubbookingsnz-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p alpineclubbookingsnz-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
docker compose --env-file .env.staging -p alpineclubbookingsnz-staging \
  -f docker-compose.yml -f docker-compose.staging.yml exec app npx tsx prisma/seed.ts
```

For a host-run development app, point `DATABASE_URL` at PostgreSQL and run:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

Do not start a development server in a shared, staging, or production checkout
unless you own that environment and intend to expose it.

After signing in with the seeded administrator, open `/admin/setup` to finish
the readiness checklist, run explicit provider tests, connect Xero, and review
booking, membership cancellation, rate, and mapping settings.

## 5. Configure Providers In Test Mode

Use non-production accounts until your own deployment is ready:

- Stripe test mode for payments and webhooks.
- Xero demo tenants for operational and finance sync flows.
- SES sandbox or another non-production SMTP setup for email.
- A dedicated Sentry project if browser/server error reporting is enabled.

Webhook routes are:

- `/api/webhooks/stripe`
- `/api/webhooks/xero`
- `/api/webhooks/ses-sns`

## 6. Validate Before Sharing

Run the core gates before opening a PR or exposing an environment:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
git diff --check
```

If you change framework behavior, read the relevant Next.js guide in
`node_modules/next/dist/docs/` first.

## 7. Prepare Deployment

Read `DEPLOYMENT.md` before production. At minimum, plan:

- DNS and TLS through Caddy or your equivalent reverse proxy.
- PostgreSQL backups and restore testing.
- GHCR image visibility or a host login with `read:packages`.
- Stripe, Xero, SES, and Sentry credentials owned by your organisation.
- A migration process that follows `BLUE_GREEN_MIGRATION_POLICY.md`.

For forks that publish GHCR images under different names, set repository
variables:

```text
GHCR_APP_IMAGE_REPOSITORY=ghcr.io/<owner>/<image-name>-app
GHCR_MIGRATE_IMAGE_REPOSITORY=ghcr.io/<owner>/<image-name>-migrate
```

The deployment wrapper also supports `GHCR_APP_IMAGE_REPOSITORY` and
`GHCR_MIGRATE_IMAGE_REPOSITORY` environment overrides on the host.

## 8. Keep A Clean Public/Private Split

Generic features, bug fixes, framework upgrades, and adopter documentation
belong in the public upstream. Deployment-specific branding, production
identifiers, service configuration, private data fixes, and real assets belong
in a private fork or deployment environment.
