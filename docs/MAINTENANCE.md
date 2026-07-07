# Maintenance

This document describes the public maintenance baseline for AlpineClubBookingsNZ.

## Required Gates

Run lightweight local gates before opening or merging application changes:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm run db:generate
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npm run typecheck
npm test
npm run quality:report
git diff --check
```

Migration/schema parity is enforced by a dedicated check. The committed
migrations in `prisma/migrations` must reproduce `prisma/schema.prisma` exactly,
or the blue/green deploy migration-safety gate aborts. Run it locally against a
throwaway database (`SHADOW_DATABASE_URL` must point at an empty, existing DB
that Prisma resets):

```bash
SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/drift_shadow \
  npm run db:check-drift   # exit 0 = in sync, 2 = drift
```

CI also runs independent static and container checks:

- `npm audit --audit-level=high --package-lock-only` on pull requests
- Semgrep with Next.js, TypeScript, JavaScript, and React rules
- gitleaks full-history and pull-request diff scans
- TypeScript, test, and Docker image build validation
- Migration drift check (`migration-drift` job) running `db:check-drift` against
  a throwaway Postgres, so schema-vs-migration drift fails the PR rather than the
  deploy
- Trivy critical vulnerability gate with high-severity warnings

## Dependency Policy

- Keep `package-lock.json` committed.
- Prefer small dependency update PRs with explicit validation results.
- Keep security overrides documented in `package.json` and remove them when the
  upstream dependency graph no longer needs them.
- Use test or demo credentials for Stripe, Xero, SES, and Sentry in local and
  CI environments.

## Supply-Chain And Deployment Security Policy

- Keep GitHub Actions default permissions at `contents: read`. Grant elevated
  permissions only on the job that needs them, such as `packages: write` for
  GHCR publishing on `main`.
- Do not reference GitHub Actions by default branches such as `master` or
  `main`. Use released major tags for trusted first-party and widely used
  actions that Dependabot can track, and use explicit release tags for scanner
  actions or images where drift would change gate behavior.
- Keep scanner container inputs isolated. Source checkouts mounted into scanner
  containers should be read-only unless the scanner must write to the source
  tree; write artifacts to `$RUNNER_TEMP` or another dedicated output mount.
- Keep production image tags commit-SHA based. Operators should deploy the app
  and migration images that match the resolved `origin/main` commit.
- Keep GHCR host tokens read-only. Production hosts need `read:packages`; CI
  publishing uses the workflow `GITHUB_TOKEN` in the publish job only.
- Treat Docker image security as two gates: CRITICAL Trivy findings fail the PR,
  while HIGH findings are warning-only until reviewed and promoted to a blocking
  policy.

Accepted residual risk:

- Most GitHub Actions remain pinned to released major tags rather than full
  commit SHAs so Dependabot and upstream patch releases can keep routine
  maintenance low-friction.
- The project does not yet publish signed image attestations or SBOM artifacts;
  image provenance is currently the commit-SHA tag, protected PR checks, and the
  GHCR package publish job.
- The `npm audit --audit-level=high` gate keeps high/critical npm advisories
  blocking, while lower severity advisories remain review-driven.

## Image Uploads Storage

Admin Image Manager uploads are written at runtime under `public/images` (served
at `/images/...`). The deployed app runs with a read-only root filesystem and
multiple replicas (blue/green), so this path must be a persistent, writable,
shared volume:

- `docker-compose.yml` mounts the `image_uploads` named volume at
  `/app/public/images` for every app replica, so uploads survive redeploys and
  are visible to all instances.
- The app runs as uid 1001. The `Dockerfile` creates `public/images` owned by
  uid 1001 so a freshly-initialised named volume inherits writable ownership.
- Relocate storage at the deployment layer by bind-mounting your chosen path at
  `/app/public/images`. The application path stays `public/images` (a trusted
  constant), which keeps the upload path-traversal checks statically verifiable.
- When the volume is missing or not writable, upload and create-directory
  requests return a clear "image storage directory is not writable" message
  (with the underlying error code) instead of a generic failure, and the cause
  is logged server-side.

## Maintainability Budgets

The repo has a handful of oversized files and route surfaces. Future
refactors should keep new code inside soft budgets so reviewers can spot
regressions early. Treat these as review prompts, not hard CI gates:

- Route handlers (`src/app/.../route.ts`) should generally stay under
  roughly 250 LOC.
- App Router page shells (`src/app/.../page.tsx`) should generally stay
  under roughly 500 LOC.
- New domain modules (`src/lib/...`, `src/components/...`) should
  generally stay under roughly 700 LOC.
- No new production `any`, type suppression (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), or `eslint-disable` without a
  short inline comment explaining the local justification.

When a file is already over budget, prefer extracting cohesive helpers
into a focused module rather than adding more to the existing surface.

### Quality report

Run the local maintainability report before opening broad refactor PRs, after
splitting a large surface, and when reviewing a PR that adds substantial
production code:

```bash
npm run quality:report
```

The script scans tracked files via `git ls-files` and prints a markdown
summary of:

- largest production files
- largest route handlers and App Router pages
- newly oversized files outside the accepted-hotspot allow-list
- largest test files
- production `any` / type-suppression hotspots
- production `eslint-disable` hotspots
- test `as any` totals

It uses only existing repo tooling, runs without external service
credentials or network access, and is advisory: it warns and informs rather
than failing the build. The `Over budget` column is a soft review prompt:
`yes` means the file exceeds the route-handler, page-shell, or new-domain-module
budget. The `Newly oversized files` section is stricter: it lists oversized
production files that are not in the accepted hotspot allow-list below, so
reviewers can spot regressions without making the report a CI gate.

### Known remaining hotspots

These files are intentionally accepted carry-over hotspots in the current
post-refactor baseline. This table is not a blanket allow-list for every file
that may appear in `npm run quality:report`. Feature-heavy releases can leave
additional advisory "newly oversized" entries visible; keep those warnings
visible unless a reviewer explicitly accepts them, and prefer follow-up
extraction over expanding this table casually.

| File | Current LOC | Disposition |
| --- | ---: | --- |
| `src/lib/xero-inbound-reconciliation.ts` | 13 | Split (#1270, #1208 item 1) into a re-export barrel over cohesive `src/lib/xero-inbound/` modules (`types`, `constants`, `amounts`, `object-links`, `audit`, `incremental-reconciliation`, `contact`, `payment`, `invoice-paid-effects`, `invoice`, `credit-note-repairs`, `credit-note`, `event-processing`). Behavior-preserving verbatim motion with an acyclic import graph (`types`/`constants` are leaves; the `event-processing` worker sits on top); the barrel re-exports the unchanged public surface (3 functions + 5 result types + `XeroInboundReplayError`). |
| `src/lib/xero-booking-repair.ts` | 2682 | Accepted as-is for now: operator repair tool, documented separately, not normal request-path code. |
| `src/lib/xero-operation-outbox.ts` | 1972 | Queued for future split when queue dispatch, release, or retry policy changes next land (PR-b of #1272 co-locates the replay stack). |
| `src/lib/email-templates.ts` | 2006 | Accepted as-is for now: central template catalogue; split only with a template-registry change. |
| `src/lib/email.ts` | 11 | Split (#1137) into a re-export facade over cohesive `src/lib/email/` modules (`core`, `admin-alerts`, `account`, `booking`, `membership`, `family`, `waitlist`, `groups`, `booking-requests`, `chores`, `ses-feedback`, plus non-re-exported `internal` plumbing). The `admin-alerts` surface was itself split (#1210) by **domain/source** — `admin-alerts.ts` is now a barrel re-exporting `admin-alerts-shared` (plumbing + `getAdminEmails`), `admin-alerts-booking`, `admin-alerts-membership`, `admin-alerts-finance`, and `admin-alerts-ops`. When an alerts/email module next exceeds the ~700 LOC soft cap, split it along the **domain axis** (booking/capacity, membership lifecycle, finance/Xero/payments, ops) — not by audience, which is fuzzy because most alerts fan out to all admins — and keep the facade barrel's exports byte-identical so `src/lib/email.ts` and every importer keep resolving. |
| `src/lib/xero-hardening.ts` | 1606 | Accepted as-is for now: central Xero hardening policy and diagnostics boundary. The `xero-hardening-canonical-links.ts` ↔ `xero-hardening-report.ts` clone pair (112 duplicated lines / 2 clones, jscpd 2026-07-07) is recorded as accepted under this same disposition (#1524 C4, owner-ticked 2026-07; same subsystem call as #1208 items 5/6). |
| `src/lib/finance-sync-xero-datasets.ts` | 1573 | Split by finance snapshot family pulled forward (#1524 C3, owner-ticked 2026-07): tracked in #1531. jscpd found 186 self-duplicated lines across 7 internal clones. |
| `src/app/(admin)/admin/members/[id]/page.tsx` | 1747 | Queued for future route-shell thinning as member-detail sections continue to move local state out. |
| `src/app/(admin)/admin/family-groups/page.tsx` | 1312 | Route-shell thinning pulled forward (#1524 C2, owner-ticked 2026-07): tracked in #1530. The duplication is specifically with `src/components/admin/family-group-editor.tsx` (225 duplicated lines / 7 clones, jscpd 2026-07-07). |

## Operational Repair Tools

`scripts/xero-booking-repair.ts` is a targeted booking/Xero reconciliation
helper. Keep it out of normal setup and deployment flows. Use it only when an
operator needs to inspect or repair known booking-payment/Xero mismatches after
reviewing the affected bookings.

Always start with a dry run:

```bash
npx tsx scripts/xero-booking-repair.ts --dry-run
npx tsx scripts/xero-booking-repair.ts --booking <bookingId> --dry-run
npx tsx scripts/xero-booking-repair.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> --dry-run
```

Only use `--apply` after the dry-run report has been reviewed. Do not run it
with live Xero, Stripe, SES, Sentry, or production database credentials during
exploratory work; use a staging database and Xero demo tenant where possible.
`XERO_AMOUNT_MISMATCH` findings are manual-review only: the tool reports stored
Xero operation/link amount evidence that disagrees with local cents, but it
does not auto-adjust financial amounts. Since #1427,
`MISSING_MODIFICATION_CREDIT_NOTE` and `MISSING_CREDIT_NOTE_ALLOCATION` are
also manual-review (not auto-queued) when the payment captured money and no
stored evidence records the policy-limited settlement — the report tells you
to size the credit note (or confirm the note's total) by hand from the
cancellation-policy history before acting; `--apply` will not touch these.
Since #1491, `LATE_CAPTURE_AFTER_CANCELLATION` is also never auto-applied:
it now fires only when a cancelled booking retains captured value with NO
recorded cancellation-refund decision (no cancellation credit, no
booking-cancel refund recovery operation), which is either a genuine late
capture or a deliberate 0%-tier policy retention. After verifying it is a
genuine late capture, execute exactly that refund with
`--apply --apply-action <actionKey>` (the key is printed next to the planned
action in the human summary and in the JSON report; combine with
`--booking <id>` to keep the rest of the apply run scoped, and note the run
warns about forced keys that matched nothing); if it is a deliberate
retention, leave it. If a multi-slice refund fails partway (one captured
Stripe intent refunds and records, a later one declines), the action reports
`failed`, but the Xero refund credit note is still queued for exactly the
slices that actually refunded — sized from the recorded refund ledger, not the
requested total — so Xero never understates the refund (#1495). Re-run
`--apply-action` with the new, smaller remainder key the report now prints (it
embeds the still-outstanding cents): it refunds only the remainder and queues a
note for exactly that delta under a distinct cumulative-watermark correlation
key, never re-noting the completed slices. Tiered cancels that
deliberately retained a policy penalty produce no finding at all — their
books are correct.

### Backfill cancel-flattened payment statuses (#1473 / #1506)

`scripts/backfill-cancel-flattened-payments.ts` is a one-off, idempotent,
local-only cleanup for the residual left by PR #1489. Before #1489,
`cancelBooking` overwrote every non-SUCCEEDED payment's aggregate `status` to
`FAILED` — including captured `(PARTIALLY_)REFUNDED` payments — while leaving
`refundedAmountCents` and the `PaymentTransaction` ledger intact. #1489 stopped
the overwrite going forward but did not backfill rows already flattened. The
read path is already correct (the booking-vs-Xero repair pass synthesizes the
captured status from the intact STRIPE mirror / ledger), so this only restores
the stored `status` field for cleanliness.

It identifies `FAILED` payments on `CANCELLED` bookings that carry capture
evidence per the exact #1489 discriminator — a captured `PaymentTransaction`
row, or (for pre-ledger STRIPE rows) `refundedAmountCents > 0` — and restores
`status` to the same value the repair pass already derives
(`PARTIALLY_REFUNDED` / `REFUNDED`, or `SUCCEEDED` for a captured-ledger row
with no refund). It deliberately skips folded never-captured internet-banking
payments (mirror refund with no captured ledger row: correctly `FAILED`) and
the narrow unrecoverable residual (no ledger, `refundedAmountCents == 0`: no
truth to restore). It makes ZERO Xero/Stripe calls, touches only `status`, and
a second run finds nothing.

Always start with a dry run (the default) against a non-production copy:

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-cancel-flattened-payments.ts
# or: npm run payments:backfill-cancel-flattened
```

Only after reviewing the dry-run report, apply inside a transaction:

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-cancel-flattened-payments.ts --apply
```

## Quarterly Backup Restore Drill

A backup you have never restored is a hope, not a backup. `scripts/backup-restore-drill.sh`
is a self-contained fire drill that proves a `pg_dump` artifact can actually be
restored, that Prisma migrations still run forward on the restored data, and
that the restored rows still satisfy the money-in-integer-cents invariants.

The drill produces the same artifact shape as the automated backup pipeline
(`src/lib/backup.ts`): a plain `pg_dump` piped through `gzip` (a `.sql.gz`
file). All work happens in a throwaway Postgres 16 container bound to
`127.0.0.1:55441`. **The drill never connects to production Postgres on port
5432, never fetches from S3, and never reads live provider credentials.**

### When to run it

- Every quarter, as a standing operations task.
- After any change to the backup pipeline (`src/lib/backup.ts`, the backup cron,
  the `BACKUP_S3_*` configuration, the database schema, or the Postgres major
  version).
- Any time you need confidence that a specific backup file is restorable.

### Local self-contained mode (default)

No arguments, no production data. The script starts the container, seeds a
source database, dumps it, restores the dump into a second database, runs
`prisma migrate deploy` forward on the restore, and checks every assertion:

```bash
bash scripts/backup-restore-drill.sh
```

Requirements: Docker with the `postgres:16` image available, plus the repo
dependencies installed (`npm ci`). The container is removed on exit even if the
drill fails. The script prints a PASS/FAIL summary suitable for pasting into an
operations log.

### Operator mode with a real backup (`--from-dump`)

Use this to prove that an actual production backup restores. **You** obtain the
dump file first; the script never touches S3 itself.

To fetch a backup safely, use read-only S3 credentials from a workstation (never
the production host) to copy one object out of the backup bucket. The backups
live under the `tacbookings_s3backup/` prefix of the bucket named in
`BACKUP_S3_BUCKET`, in the region from `BACKUP_S3_REGION` (default
`ap-southeast-2`), using the `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`
credentials. Copy a single `.sql.gz` object to a local scratch path — do not
print or paste credential values, and do not run this on a production host:

```bash
# Values come from your operator secret store; never echo them.
aws s3 cp "s3://$BACKUP_S3_BUCKET/tacbookings_s3backup/<backup-file>.sql.gz" \
  /tmp/restore-check.sql.gz --region "$BACKUP_S3_REGION"

bash scripts/backup-restore-drill.sh --from-dump /tmp/restore-check.sql.gz
```

In `--from-dump` mode the source-fidelity comparisons are reported as `SKIP`
(there is no local source to compare against); the sentinel and migration
assertions still run against the restored database. Delete the downloaded dump
when you are done.

### What the assertions prove

- **Restore fidelity** (local mode only): row counts for `Member`, `Booking`,
  `Payment`, `BookingGuest`, and `BookingGuestNight` match the source exactly,
  and `SUM("finalPriceCents")` over `Booking` and `SUM("amountCents")` over
  `Payment` match the source exactly as integers. This proves the dump/restore
  round-trip loses no rows and no cents.
- **Sentinel invariants** (both modes): the restored database has zero `Booking`
  rows with a `NULL` or negative `finalPriceCents` and zero `Payment` rows with a
  `NULL` or negative `amountCents`. This proves the money-in-integer-cents
  invariant survives the round-trip.
- **Migration health** (both modes): after `prisma migrate deploy`, the
  `_prisma_migrations` table has zero rows still in progress (`finished_at IS
  NULL AND rolled_back_at IS NULL`). This proves migrations run forward cleanly
  on top of the restored data.

### On failure

A failing drill is a **backup-pipeline incident**, not a routine test flake:

1. Do **not** overwrite, prune, or re-run the backup job — preserve every
   existing backup artifact as evidence.
2. Capture the full drill summary output.
3. Escalate to the owner before taking any corrective action on the backup
   pipeline. Restoring or repairing production data is an owner-approved,
   high-risk operation.

## Public Reference Release Checklist

Before cutting a public reference release:

1. Create a release-prep branch from fresh `origin/main`.
2. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the
   release version.
3. Check `README.md`, `DEPLOYMENT.md`, `CONFIGURATION.md`, this maintenance
   guide, and `docs/ARCHITECTURE.md` for dependency, release, GHCR, migration,
   validation, and public/private workflow drift.
4. Confirm any new or changed migrations that touch hot tables or potentially
   breaking SQL are represented in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, or
   document why no ledger entry is needed.
5. Run local release validation without live provider credentials, then rely on
   GitHub Actions for Docker image build, static analysis, secret scanning,
   dependency review, and GHCR publication.
6. After merge, create the annotated release tag on the merged commit and
   publish the GitHub release with validation evidence, migration notes, image
   names, commit SHA, and non-blocking maintainability follow-ups.

## GitHub Actions Availability

If Actions jobs fail before starting, check repository or account billing and
spending limits before treating the failures as code failures.
