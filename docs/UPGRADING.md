# Upgrading

This guide is for **downstream forks and adopters** of AlpineClubBookingsNZ that
run their own deployment (for example `{$DOMAIN}`). It explains how to move a
live deployment from one public release to the next safely.

It complements the two documents next to it and does not repeat them:

- `docs/ONGOING_DEVELOPMENT_WORKFLOW.md` covers the **git** side — how a private
  fork keeps its history in sync with the public upstream. Read it for branching
  and merge hygiene.
- This file covers the **operational** side — how to take the code you have
  synced and roll it onto a running database and deployment without losing data
  or breaking the live app color mid-deploy.

## Principles

1. **Upgrade tag-to-tag, one release at a time.** Deploy released tags
   (`v0.9.0` → `v0.10.0`), not arbitrary `main` commits. Each release's
   Migration/deployment notes and this guide assume you are coming from the
   immediately previous tag. Skipping releases means you also skip their
   post-upgrade actions. If you must catch up several releases, apply each
   release's notes in order.
2. **Always back up the database before migrating.** A backup you have never
   restored is a hope, not a backup — see the Quarterly Backup Restore Drill in
   `docs/MAINTENANCE.md`. Take a fresh `pg_dump` immediately before every
   upgrade that runs migrations, and confirm it restores before you cut over.
3. **Read the changelog and the blue/green migration-safety ledger before you
   deploy.** `CHANGELOG.md` groups each release's changes and ends with a
   Migration/deployment notes block. `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` is
   the per-migration safety ledger. Together they tell you which migrations
   need a low-traffic window, which are destructive, and which change behaviour.
4. **Deployments are blue/green.** Migrations run before the new app color
   receives traffic while the **old** color can still be serving requests
   against the shared database (see `docs/BLUE_GREEN_MIGRATION_POLICY.md`). Most
   migrations are written to stay old-code-compatible so the old color keeps
   working during the drain. A few are not (see below) — those need a quiet
   window or a deferral.

## How to read `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

The ledger is a tab-separated file with one row per notable migration and these
columns:

| Column | What it tells you |
| --- | --- |
| `migration_name` | The `prisma/migrations/<timestamp>_<name>` folder. |
| `phase` | `expand` (adds shape), `contract` (removes shape), or `metadata-only`. |
| `previous_expand_release` | For a `contract` migration, the earlier expand/runtime release it depends on. Do not deploy a contract migration before the named expand release has fully drained. |
| `old_code_compatible` | `yes` = the previously deployed app color keeps working while this migration is applied. **`no` = the old color can error against the migrated rows** — this migration needs a quiet window or a deferral, described in its `lock_impact_plan`. |
| `lock_impact_plan` | Plain-language notes: which tables it locks, when to run it, and any operator caveat (quiet window, defer option, "run during low X traffic"). |

Before a deploy:

1. List the migrations pending for your database (folders under
   `prisma/migrations` newer than the last one your database has applied).
2. Look each up in the ledger. Note any row with `old_code_compatible=no`, any
   `contract` row, and any `lock_impact_plan` that names a hot table (`Member`,
   `Booking`, `Payment`, membership/finance/auth tables) or a traffic window.
3. Schedule the deploy for the quietest window those rows require, and line up
   the post-upgrade actions from the release's Migration/deployment notes.

The PR-time coverage gate (CI's `migration-drift` job) guarantees every
hot-table or potentially-breaking migration at or after the ledger baseline has
a ledger row, so if a pending migration is missing from the ledger, treat that
as a red flag and check the release notes before deploying.

## Generic upgrade procedure

1. Sync the code to the target release tag (see
   `docs/ONGOING_DEVELOPMENT_WORKFLOW.md`).
2. Read this release's `CHANGELOG.md` section end to end, especially its
   Migration/deployment notes, and cross-check the pending migrations against
   `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.
3. Take and verify a database backup.
4. Choose the deploy window: low-traffic if any pending migration says so, and a
   **quiet window** (or a deferral) if any pending migration is
   `old_code_compatible=no`.
5. Run the deploy (`scripts/run-production-blue-green-deploy.sh` runs the
   migration-safety validator, then `prisma migrate deploy`, then cuts traffic
   over to the new color).
6. Complete the post-upgrade actions for the release (below). Confirm the app is
   healthy on the new color before you consider the upgrade done.

---

## v0.10.1 → v0.11.0

`v0.11.0` is a large minor release with 30 migrations and first-class
multi-lodge operation. It also adds configuration transfer, declared-partner
and shared-double workflows, admin booking recovery/override controls, and an
application-wide design/accessibility refresh. Read the full release inventory
in `docs/releases/v0.11.0.md` and the `0.11.0` changelog section before starting.

### Before deployment

1. **Take and restore-test a fresh backup.** Do not use Configuration Export as
   a database backup; it intentionally excludes members and transactional data.
2. **Schedule a quiet, low-write window.** The lodge-scoping migrations touch
   booking and operational tables. The booking capacity-hold and persisted
   capacity-override migrations each scan `Booking` to build an index, although
   their new columns are nullable and initially empty.
3. **Audit the capacity ceiling.** When Bed Allocation is enabled,
   `LodgeSettings.capacity` now caps the active-bed count. Run the read-only
   detection query in `docs/CAPACITY_MODEL.md` and confirm every lodge whose
   configured capacity is below its installed active-bed count.
4. **Plan the contract-migration window.** Review these ledger rows in
   `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`:
   - `20260708220100_drop_member_induction_item_result` is safe only after
     confirming the retired table contains no data that must be retained.
   - `20260708220200_drop_member_induction_self_assessment_columns` can make
     old-colour induction default reads/writes fail until cutover.
   - `20260708220300_drop_finance_report_mapping_label_columns` can make
     old-colour finance dashboard/mapping reads fail until cutover.
   - `20260709130000_drop_email_message_setting_lodge_identity_columns` can
     make old-colour email-settings and lodge-admin writes fail; member email
     settings fall back while the old colour drains.

   Idle or drain those affected old-colour paths, cut over promptly, and use
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` only with a non-empty
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` that acknowledges the reviewed
   windows. Do not use the override to bypass an unreviewed validator failure.
5. **Confirm default-lodge intent.** The migration sequence converts the
   existing installation into a lodge record and scopes dependent records to
   it. Record which lodge should be default before deployment so the result can
   be checked immediately after cutover.

### Post-upgrade actions

1. Open **Admin > Lodges** and confirm the expected lodge is the default, each
   active lodge has the intended capacity, rooms/beds, seasons/rates,
   instructions, and door-code/travel identity, and lodge-scoped records appear
   under the correct lodge.
2. Review **Admin > Modules** and lodge/member access. Confirm all capabilities
   the club uses remain enabled and that kiosk, chores, finance, waitlist, Xero,
   bed allocation, Internet Banking, and multi-lodge access match policy.
3. Smoke-check a booking capacity quote, Admin Bookings, bed allocation,
   waitlist, hut leaders, roster, and kiosk for every active lodge. Do not create
   live financial transactions merely to test the release.
4. Open the Finance dashboard and Xero mappings/sync views, then verify an
   ordinary operational email resolves the correct lodge identity. This checks
   the contract-migration cutover without contacting live providers
   unnecessarily.
5. Review **Admin > Site Style** and the public/login/member/admin shells in
   light and dark mode. Untouched default themes are reseeded from sage to teal;
   completed, partially customised, and non-default themes are left unchanged.
6. Review **Admin > Notifications**. Eleven previously hardcoded operational
   templates are now editable but remain locked to always-send; `two-factor-code`
   remains hardcoded because it is authentication-critical.

No one-off data backfill command is required after a successful migration. The
release's data repairs and lodge scoping are migration-driven and idempotent.

---

## v0.10.0 → v0.10.1

`v0.10.1` is a patch release: four payment/booking-recovery hardening changes
and one operator cleanup script (see the `CHANGELOG.md` `0.10.1` section). It
contains **no database migrations** and no schema changes — there is nothing to
look up in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, and either app color can
serve throughout the deploy. The standard procedure still applies: back up the
database before deploying.

### Post-upgrade actions

None required.

**Optional cleanup:** if your fork ever ran a pre-`v0.10.0` build (any build
older than PR #1489), booking cancellations may have flattened captured
`(PARTIALLY_)REFUNDED` payments' stored `status` to `FAILED`. The read path
already compensates, so this is cosmetic-only for the stored rows. You can
restore them with `npm run payments:backfill-cancel-flattened` (dry-run by
default; review the report before re-running with `--apply`). See "Backfill
cancel-flattened payment statuses" in `docs/MAINTENANCE.md`.

---

## v0.9.0 → v0.10.0

`v0.10.0` bundles a large quality-and-hardening wave, a remediation wave
(epic #1348), and a live-feedback admin-UX wave (epic #1438). Most of its ~49
migrations are ordinary expand migrations, but a few need operator attention.
Read the full `CHANGELOG.md` `0.10.0` section for the complete list; the
post-upgrade actions that matter are below.

### Post-upgrade actions

1. **Re-enable capability modules you use (destructive default change).**
   `20260627120000_core_module_defaults_off` switches the high-risk capability
   modules — **kiosk, chores, finance dashboard, waitlist, Xero integration, bed
   allocation, and Internet Banking payments** — to default `false`, and repairs
   only the untouched singleton `ClubModuleSettings` row (the one where
   `updatedByMemberId IS NULL`, i.e. never admin-saved). If your fork never
   opened and saved **Admin > Modules**, these features will switch **OFF** on
   upgrade. After upgrading, open **Admin > Modules** and re-enable the ones you
   use once the underlying provider/setup is ready. Rows an admin has already
   saved are left untouched; general-purpose modules stay default-on.

2. **Complete or export in-flight inductions first (destructive data change).**
   `20260702100000_induction_workflow_types` moves inductions to a single-Pass
   flow and, as part of that, **deletes in-flight (`DRAFT`/`IN_PROGRESS`)
   per-item induction results and clears their self-assessment state**.
   Completed historical inductions are preserved. Before upgrading, complete or
   export any inductions that members have started but not finished.

3. **Audit membership access roles if you ran intermediate `main`.**
   `20260630120000_rename_member_role_to_user` (a `contract` migration) collapses
   the legacy `Member.role` `MEMBER`/`ASSOCIATE`/`LIFE` values into `USER` and
   recreates the `Role` enum. It assumes **no live deployment used the
   intermediate Access-Roles window**. If your fork deployed a `main` build
   between **2026-06-28 and 2026-06-30**, run
   `npm run db:audit-access-role-cleanup` after upgrading and resolve anything it
   reports. Forks that upgraded tag-to-tag (from `v0.9.0`) never entered that
   window and can skip this.

4. **Plan the AgeTier `NOT_APPLICABLE` migration deploy (owner-decided plan).**
   `20260707000000_add_age_tier_not_applicable` adds a `NOT_APPLICABLE` age tier
   and `20260707000100_backfill_org_age_tier_not_applicable` flips ADULT
   organisation-type members (legacy SCHOOL role or ORG access role) to it. The
   backfill row is `old_code_compatible=no`: a pre-`v0.10.0` app color cannot
   deserialize `NOT_APPLICABLE`, so while both colors are live, old-color reads
   of the flipped rows (the admin members list, that member's detail, school
   flows) can error between migrate and cutover. This is the classic blue/green
   enum-backfill hazard — writing a brand-new enum value into hot-table rows at
   migrate time breaks the old color's reads until it drains.

   The upstream owner ratified the deploy plan on epic #1438 on **2026-07-07**:

   > **Backfill deploy strategy — Quiet window:** ship both #1440 migrations
   > normally, deploy at low traffic, cut over promptly (per the
   > `BLUE_GREEN_MIGRATION_SAFETY.tsv` row; the defer-the-backfill option remains
   > documented as the operator fallback).

   So: **deploy both AgeTier migrations in a quiet window and cut over
   promptly**, or **defer** `20260707000100_backfill_org_age_tier_not_applicable`
   until the old color has fully drained and re-run it then (the `UPDATE` is
   idempotent and safe to run late). The enum-add migration is a plain expand and
   is safe in either plan. The ledger row for the backfill records the same
   caution.

### Verified blue/green-safe — no re-audit needed

You do not need to re-audit these; they are recorded old-code-compatible in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`:

- The `ClubTheme` sub-AA gold theme bump only rewrites a persisted theme still on
  the old default; installs that changed their theme are untouched (#1244).
- The `ClubTheme` generic sage-to-teal correction only rewrites the incomplete
  `default` row when every stored theme value still exactly matches the legacy
  generic defaults after #1244. Completed themes, partially customised themes,
  and Tokoroa themes are untouched (#1832).
- The `BookingGuestNight` backfill runs automatically and old code ignores the
  table.
- The access-role backfills keep old code reading
  `Member.role`/`financeAccessLevel` unchanged while the new tables are added.

### Behaviour changes worth telling operators about

- **Capability modules default off** (see action 1) — the most visible change.
- **Booking Officer / on-behalf booking scope widened** — Booking Officers can
  see booking detail and `bookings:edit` holders can create/quote on behalf of
  members (their own bookings still go through normal member payment paths).
- **Email preferences are enforced** on reminder/chores sends — member opt-outs
  are now honoured.
- **Non-member hold policy is admin-toggleable.**
- **Cancellation policy — tiered credit restore.** A member who paid with account
  credit and cancels inside the 0%-refund window now forfeits that value like a
  card payer, instead of getting it all back. A captured-but-partially-refunded
  cancel is tiered on the remaining value. If your club has not briefed its
  committee on this, do so before wider rollout.
