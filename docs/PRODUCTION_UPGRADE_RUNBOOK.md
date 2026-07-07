# Production Upgrade Runbook

This runbook takes an existing production deployment from a `v0.9.0`-era release
up to `v0.10.0` on the supported blue/green deploy path. It is written for the
operator of a private deployment fork whose production database still predates
the July migration wave, and it is deliberately generic: substitute your own
values for placeholders such as `<owner>` (GitHub owner) and
`https://your-domain.example` (your public domain).

It is a High-risk procedure against live club data. **The owner drives or
approves each step.** Do not run any step against production without the owner
present for the window. Read this whole document, complete the staging
rehearsal, then work top to bottom during the production window and fill in the
[Production execution record](#8-production-execution-record) as you go.

## 0. Scope and companion documents

- Version target: `v0.9.0`-era → `v0.10.0`. Confirm the exact
  tags/commit SHAs before you start (see [§1 pre-flight](#1-pre-flight)).
- Read alongside:
  - `docs/UPGRADING.md` — the fork-facing tag-to-tag upgrade guide and the
    v0.10.0 release notes (the source of truth for the two
    destructive/behaviour changes; published with the release).
  - `docs/BLUE_GREEN_MIGRATION_POLICY.md` — the migration compatibility contract
    and the deploy gate this runbook relies on.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` — the per-migration safety ledger the
    gate reads.
  - `DEPLOYMENT.md` — the supported blue/green deploy path and health endpoints.
  - `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill" — the restore-test
    tooling used in pre-flight.

### What does not change

The upgrade path does not alter the money or booking invariants: money stays in
integer cents end to end, and booking dates stay NZ date-only lodge nights. No
migration in the `v0.9.0 → v0.10.0` set rescales, rounds, or re-times either.
Reconciliation totals before and after the upgrade must match to the cent
(see the [§3 spot-check](#3-post-upgrade-checklist)).

---

## 1. Pre-flight

Complete every item below **before** touching the deploy. None of these steps
writes to production; the SQL is read-only.

### 1.1 Verified, restore-tested database backup (with S3 durability confirmed)

A backup you have never restored is a hope, not a backup.

1. Confirm backup **durability first**. Historically, an S3-less host wrote
   `pg_dump` artifacts to a RAM `tmpfs` that every redeploy wiped, while the
   backup job still reported daily SUCCESS — see issue **#1361**
   (`S3-less backups report daily SUCCESS while dumps sit on RAM tmpfs wiped
   every deploy; defaults ship backups OFF`). Before you rely on any backup for
   this upgrade, verify that `BACKUP_S3_*` is configured and that the latest
   artifact actually landed in durable S3 storage (not a tmpfs path that the
   deploy will erase).
2. Take a fresh backup immediately before the window, or confirm the most
   recent durable S3 artifact is the one you will restore from.
3. **Restore-test it** with `scripts/backup-restore-drill.sh --from-dump`
   (see `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill"). Fetch the
   `.sql.gz` object with read-only S3 credentials **from a workstation, never
   the production host**, then run the drill against a throwaway Postgres 16
   container. The drill proves the dump restores, that Prisma migrations run
   forward on the restored data, and that the money-in-integer-cents sentinels
   hold. Record `Result: PASS` and the backup object id before proceeding.

> A backup that has not been restore-tested does not satisfy this step. The
> induction-item-results deletion in [§2](#2-migrate) is **not reversible** by
> the deploy — this backup is the only recovery path for it. Do not proceed
> without a PASS.

### 1.2 Predict the module-flip: `ClubModuleSettings.updatedByMemberId`

Migration `20260627120000_core_module_defaults_off` switches seven capability
modules **off** for any deployment whose singleton `ClubModuleSettings` row was
never admin-saved. Its `UPDATE` is gated on
`WHERE "id" = 'default' AND "updatedByMemberId" IS NULL`, so
`updatedByMemberId` predicts whether the flip will hit you.

Run this read-only SELECT against production before the window and capture the
output:

```sql
SELECT
  "updatedByMemberId",
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
  "bedAllocation",
  "internetBankingPayments"
FROM "ClubModuleSettings"
WHERE "id" = 'default';
```

Interpretation:

- **`updatedByMemberId` IS NULL** → the migration will set all seven of
  `kiosk`, `chores`, `financeDashboard`, `waitlist`, `xeroIntegration`,
  `bedAllocation`, and `internetBankingPayments` to `false`. **Write down which
  of these seven are currently `true`** — you will re-enable exactly those in
  Admin > Modules in [§3](#3-post-upgrade-checklist).
- **`updatedByMemberId` IS NOT NULL** → the row was admin-saved; the migration
  leaves it untouched and no module flips. No post-upgrade re-enable is needed
  for this reason (still confirm the toggles in [§3](#3-post-upgrade-checklist)).

### 1.3 List in-flight inductions whose item results will be deleted

Migration `20260702100000_induction_workflow_types` **deletes**
`MemberInductionItemResult` rows and **NULLs** `selfAssessedAt` /
`selfAssessmentJson` for every `MemberInduction` in status `DRAFT` or
`IN_PROGRESS`. Completed historical inductions are preserved; only in-flight
per-item and self-assessment state is retired. **This deletion is not
reversible** except from the [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
backup.

Run this read-only SELECT before the window and capture the output. Consider
completing or exporting any listed induction first if its per-item detail
matters:

```sql
SELECT
  mi."id",
  mi."memberId",
  mi."kind",
  mi."status",
  mi."createdAt",
  COUNT(r."id") AS item_results_to_delete
FROM "MemberInduction" mi
LEFT JOIN "MemberInductionItemResult" r
  ON r."inductionId" = mi."id"
WHERE mi."status" IN ('DRAFT', 'IN_PROGRESS')
GROUP BY mi."id", mi."memberId", mi."kind", mi."status", mi."createdAt"
ORDER BY mi."memberId";
```

A non-empty result means item results and self-assessment state for those
inductions will be gone after [§2](#2-migrate). An empty result means nothing is
lost. Either way, record the count in the execution record.

### 1.4 Capture the current version/tag

Record the currently deployed release tag and commit SHA (the "from" version),
and the target `v0.10.0` tag and its resolved `origin/main` SHA (the "to"
version). The deploy script snapshots the resolved `origin/main` commit and
selects the matching GHCR image tags, so pin exactly which commit you are
deploying and note it in the execution record for rollback reasoning.

### 1.5 Confirm the staging dress rehearsal is recorded

Do not run production until the [§7 staging rehearsal record](#7-staging-rehearsal-record)
shows a PASS with a date. The rehearsal runs the same wave migrations against a
staging copy of live data; it is the evidence that the migrate step behaves on
your data shape.

---

## 2. Migrate

Migrate via the supported blue/green deploy path. Run from the production host:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The script re-enters itself with `--internal-blue-green-deploy` and runs a
19-step engine (`scripts/run-production-blue-green-deploy.sh`). The steps that
matter for this upgrade:

- **Step 12/19 — "Validating Prisma schema against committed migrations".**
  This runs `validate_pending_migrations_blue_green_safe`, which calls
  `scripts/validate-blue-green-migrations.sh` against every pending migration.
  This is the gate. It must pass green (see [§2.1](#21-the-validator-gate-is-expected-green)).
- **Step 13/19 — "Running Prisma migrations".** `prisma migrate deploy` runs
  through the `migrate` service, applying the pending migrations to the shared
  Postgres **while the old color can still be serving traffic**.
- **Step 14/19 / Step 15/19 — starts the new (target) web color and refreshes
  the cron leader on the new release, both before cutover.**
- **Step 16/19 — "Switching Caddy upstream to target web service".** This is
  the **cutover**: Caddy is repointed to the new color, external/internal health
  is verified, then the previous color's connections are drained. Everything
  before this step is reversible by aborting; see [§4](#4-rollback-plan).

### 2.1 The validator gate is expected green

`main` ledgers **all** pending `v0.9.0 → v0.10.0` migrations in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, including the two that a hot-table /
trigger scan flags:

- `20260702180000_add_two_factor_session_challenge` (FK to `Member`), and
- `20260704100000_defer_booking_guest_stay_range_triggers` (trigger swap on
  `Booking` / `BookingGuest`).

The validator's hot-table regex covers `CREATE`/`DROP TRIGGER` and
`CREATE CONSTRAINT TRIGGER`, and CI's `migration-drift` job runs
`scripts/check-migration-safety-coverage.sh` on every PR so a regex-matching
migration cannot merge without a ledger row. So step 12 is **expected to pass**.

**If step 12 fails at "missing ... entry for blue/green migration safety
review":** stop. Do **not** reach for `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` —
that flag only bypasses the *potentially-breaking-SQL* warning
(`found_breaking`); it does **not** bypass a missing/malformed ledger entry
(`found_failure`), and it additionally requires a non-empty
`BLUE_GREEN_MIGRATION_OVERRIDE_REASON`. A missing-entry failure on a clean
`v0.10.0` checkout means your migration tree or ledger has drifted from
`origin/main` — reconcile the checkout against the release tag rather than
editing the ledger on the host. The gate fails **safe**: the old color keeps
serving and no schema change has been applied.

### 2.2 AgeTier `NOT_APPLICABLE` — deploy in a quiet window

The `v0.10.0` set includes the #1440 AgeTier work. The backfill migration
`20260707000100_backfill_org_age_tier_not_applicable` is ledgered
`old_code_compatible=no`. Its ledger row states:

> Single UPDATE flipping ADULT organisation-type members (legacy SCHOOL role or
> ORG access role) to the new NOT_APPLICABLE AgeTier value; touches only those
> rows (typically a handful per club) with brief row locks and no DDL. CAUTION:
> pre-#1440 Prisma clients cannot deserialize NOT_APPLICABLE, so old-color reads
> of the flipped rows (admin members list, that member's detail, school flows)
> can error between migrate and cutover — deploy in a quiet window and cut over
> promptly, or defer this migration until the old color drains (the UPDATE is
> idempotent and safe to run late).

The owner ratified the deploy strategy (owner decision record, 2026-07-07, on
epic #1438):

> **Quiet window**: ship both #1440 migrations normally, deploy at low traffic,
> cut over promptly (per the BLUE_GREEN_MIGRATION_SAFETY.tsv row; the
> defer-the-backfill option remains documented as the operator fallback).

and the Wave-4 operator reminder:

> #1440's migrations follow the ratified quiet-window plan — deploy at low
> traffic and cut over promptly (or defer
> `20260707000100_backfill_org_age_tier_not_applicable` until the old color
> drains; it is idempotent).

**Operator action for `v0.10.0`:** schedule this production window at **low
member-admin traffic**, and minimise the gap between step 13 (migrate) and step
16 (cutover) so the window where the old color could read a flipped
`NOT_APPLICABLE` row is as short as possible. If you cannot deploy in a quiet
window, the documented fallback is to defer only
`20260707000100_backfill_org_age_tier_not_applicable` until the old color has
fully drained onto the new runtime, then run that single migration late — it is
idempotent and safe to run once the new code is serving all traffic.

### 2.3 Verify the migrate step

Step 13 runs `verify_prisma_migration_status`; confirm the engine reports the
database is up to date and that the new color passes `/api/health/ready` before
cutover. Then let step 16 perform the cutover.

---

## 3. Post-upgrade checklist

Work these after a successful cutover.

### 3.1 Re-enable modules in Admin > Modules

If [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
predicted a flip (`updatedByMemberId` was NULL), the following seven toggles
were reset to **off** by `20260627120000_core_module_defaults_off`. Re-enable
in **Admin > Modules** exactly those that were `true` before the upgrade
(from your [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
capture), after confirming provider/setup readiness for each:

1. `kiosk`
2. `chores`
3. `financeDashboard`
4. `waitlist`
5. `xeroIntegration`
6. `bedAllocation`
7. `internetBankingPayments`

Saving the module page stamps `updatedByMemberId`, so this reset is a one-time
event, not a recurring one.

### 3.2 Historical access-role/membership cleanup window

The temporary access-role and membership-type cleanup rehearsal applied only to
forks that deployed an intermediate `main` during the 2026-06-28 .. 2026-06-30
window. That fork migration window is closed, and the disposable-data rehearsal
note has been retired from the living documentation set. A fork upgrading from
a `v0.9.0`-era tag straight to `v0.10.0` does not need this check.

### 3.3 Spot-check money and integrations

- Open the **Xero reconciliation report** and confirm it reconciles; totals must
  match the cent. Money is integer cents — no rounding or rescale is introduced
  by this upgrade, so pre- and post-upgrade totals should agree exactly.
- Spot-check a handful of recent **bookings** and their **payments**: prices,
  captured amounts, and refunds/credits should read identically to before the
  upgrade.

### 3.4 Manual E2E-critical journeys

Drive each critical journey by hand against the live site
(`https://your-domain.example`):

1. **Login**, including **2FA** (the two-factor challenge/session tables ship in
   this release — confirm a 2FA-enrolled member can complete a challenge).
2. **Book** a lodge night (dates render as the expected NZ date-only nights).
3. **Pay** for a booking end to end.
4. **Admin approve** a booking/application.

Any failure here is a signal to consider [§4 rollback](#4-rollback-plan).

### 3.5 Fork automation note: removed `POST /api/bookings/cancel`

The body-based `POST /api/bookings/cancel` route has been removed. If any fork
automation, script, or integration still calls that endpoint, it will now 404 —
repoint it to the current cancellation surface before relying on the upgraded
deployment.

---

## 4. Rollback plan

Rollback follows `docs/BLUE_GREEN_MIGRATION_POLICY.md`. The policy's whole point
is that migrations preserve old-code/new-schema compatibility until the previous
color drains, which makes the rollback boundary the **cutover (step 16)**.

### Before cutover (up to and including step 13/14/15)

The **old color is still serving traffic**. Migrations are expand-shaped and
old-code-compatible, so if the new color fails to come up healthy, or you abort
before step 16, you can stop the deploy and leave the old color serving the
already-migrated (backward-compatible) schema. This is a blocked upgrade, not an
outage. No traffic ever reached the new color.

### After cutover (step 16 onward)

Traffic is on the new color. To fall back you re-point Caddy to the previous
color (the engine restores the previous upstream file on a failed reload; a
deliberate rollback is the same operation in reverse) while the old color
containers are still present. Because the schema is expand-only and
old-code-compatible, the previous color can serve against the migrated database.

### What is NOT reversible by rollback

- **The induction item-results deletion** from
  `20260702100000_induction_workflow_types` is a hard `DELETE` (plus NULLed
  self-assessment fields). Re-pointing Caddy does **not** bring those rows back.
  The [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
  restore-tested backup is the **only** recovery path for that data.
- The `20260627120000` module-flip and the `20260707000100` AgeTier backfill are
  data changes, not schema removals; they are re-doable/idempotent rather than
  auto-reversed. Re-enable modules via Admin > Modules ([§3.1](#31-re-enable-modules-in-admin--modules)).
  Treat any need to un-flip AgeTier rows as an owner-approved data operation.

If a rollback becomes necessary, capture evidence, re-point to the old color to
restore service, and escalate to the owner before any data-repair action.

---

## 5. Invariant reminders

- Money stays in **integer cents** everywhere; this upgrade introduces no
  rescaling or rounding. Reconciliation totals must be cent-identical before and
  after.
- Booking dates stay **NZ date-only lodge nights**; no migration re-times or
  re-zones them.
- The blue/green gate stays idempotent and fails safe; external provider calls
  stay outside long database transactions.

---

## 6. Sign-off gate

- [ ] [§1](#1-pre-flight) pre-flight complete: restore-tested backup PASS, S3
      durability confirmed (#1361), module-flip prediction captured, in-flight
      inductions listed, from/to versions pinned, staging rehearsal recorded.
- [ ] [§2](#2-migrate) migrate: validator gate green (step 12), migrations
      applied (step 13), AgeTier quiet-window observed, cutover clean (step 16).
- [ ] [§3](#3-post-upgrade-checklist) post-upgrade: modules re-enabled,
      access-role audit run if applicable, money/Xero spot-check clean, all four
      critical journeys pass, fork automation repointed off the removed cancel
      route.
- [ ] Owner present for the window and signs off the
      [execution record](#8-production-execution-record).

---

## 7. Staging rehearsal record

The private deployment fork's **staging** environment has already run the July
wave migrations against a **live-DB snapshot** — that run is the dress
rehearsal for this upgrade. This is asserted **per the 2026-07-06 audit /
issue #1364**. The owner confirms the concrete date and outcome below before the
production window opens.

| Field | Value |
| --- | --- |
| Rehearsal environment | Private fork staging (live-DB snapshot) |
| Wave migrations applied | `v0.9.0`-era → `v0.10.0` set (all pending) |
| Rehearsal date | _<owner to confirm — YYYY-MM-DD>_ |
| Result (PASS/FAIL) | _<owner to confirm — must be PASS before production>_ |
| Notable findings / deviations | _<owner to confirm>_ |
| Confirmed by | _<owner>_ |

> A recorded PASS here is a precondition for [§2](#2-migrate). If the rehearsal
> has not been recorded, do not run production.

---

## 8. Production execution record

Fill this in live during the production window.

| Field | Value |
| --- | --- |
| Execution date | _<YYYY-MM-DD>_ |
| Operator | _<name>_ |
| Owner present | _<name>_ |
| From version (tag / SHA) | _<...>_ |
| To version (tag / SHA) | _<v0.10.0 / SHA>_ |
| Backup object id (restore-tested) | _<...>_ |
| S3 durability confirmed (#1361) | _<yes/no>_ |
| Module-flip predicted (updatedByMemberId NULL?) | _<yes/no + toggles to re-enable>_ |
| In-flight inductions affected (count) | _<...>_ |
| Validator gate result (step 12) | _<green / details>_ |
| AgeTier plan (quiet window / deferred backfill) | _<...>_ |
| Cutover time (step 16) | _<HH:MM TZ>_ |
| Modules re-enabled | _<list>_ |
| Access-role audit run / result | _<n/a or PASS>_ |
| Money + Xero spot-check | _<clean / notes>_ |
| Critical journeys (login+2FA / book / pay / approve) | _<pass/fail each>_ |
| Post-checklist sign-off (owner) | _<name + time>_ |
