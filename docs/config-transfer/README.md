# Configuration Export & Import (config transfer)

A full-admin tool that exports a club's configuration, site content, and lodge
setup as a single portable zip bundle, and imports such a bundle into another
(or the same) instance through a plan → resolve → apply flow.

Feature issue: hoppers99/AlpineClubBookingsNZ#22 (fork). Available to full
admins at **Admin → Setup & Configuration → Export & Import**
(`/admin/config-transfer`).

## Using it

- **Export:** tick the categories to include (door codes are opt-in), download a
  `.zip` bundle.
- **Import:** upload a bundle → a mandatory **dry-run** shows exactly what will
  be created/updated per entity (plus door-code and Xero-org warnings) → confirm
  to apply. The server takes a `pg_dump` backup first, applies inside one
  transaction under a single-flight advisory lock, and audits the result. Import
  **never deletes**, so a "restore" won't remove anything added since the export;
  the pre-apply backup is the true rollback.

## Implemented categories

- **site-content** — CMS pages, keyed site content, club theme; embedded images
  travel in the bundle and their `/api/images/<id>` references are remapped on
  import.
- **club-settings** — the club-wide settings singletons (modules, booking
  defaults, member-fields, bed-allocation, booking-request, IB payments, email
  message settings, group discount, membership nomination/lockout/cancellation).
- **lodge-config** — lodges, rooms, beds, seasons, and season rates (foreign
  keys carried as natural keys — lodge slug, room/season name). Per-lodge
  capacity/LodgeSettings is intentionally excluded (see ADR-001).

Remaining designed categories (same pattern, not yet built): lodge policies
(cancellation / booking-period / minimum-stay), lodge instructions, chore
templates, committee (roles + standalone), induction templates, and Xero config
mappings. The `xero-config` cross-org tenant check is wired in the manifest and
plan for when that category lands.

## What it is / is not

- **Is:** a portable, human-editable, database-id-free interchange for
  *configuration, content, and lodge setup* — pages, settings, lodges, rooms,
  beds, seasons, rates, policies, instructions, chore templates, committee
  roles, induction templates, Xero configuration mappings.
- **Is not:** a database backup. The `pg_dump` subsystem (`src/lib/backup.ts`)
  remains the whole-database disaster-recovery tool. Import here **never
  deletes** — restoring a bundle will not remove things added after it was
  exported; the automatic pre-apply DB backup is the true rollback.
- **Never contains:** secrets, members, auth/role fields, transactional data
  (bookings, payments, credits, allocations), Xero connection/runtime state,
  or (by default) lodge door codes.

## Decision records

- [ADR-001 — Interchange format and identity strategy](decisions/ADR-001-interchange-format-and-identity-strategy.md)
- [ADR-002 — Import semantics and safety model](decisions/ADR-002-import-semantics-and-safety.md)
- [ADR-003 — Install-time bootstrap integration](decisions/ADR-003-install-seed-integration.md) (deferred)

## Implementation notes

- The import plan is **stateless**: computed for the dry-run, returned to the
  client, and re-derived at apply time. A **fingerprint** of the touched rows is
  taken at plan time and re-checked at apply; if the database changed in between,
  the apply is refused and the admin re-runs the dry-run (ADR-002). No schema
  migration is required.
- Single-flight import lock: `pg_advisory_xact_lock(hashtext('config-transfer-import'))`
  (see `docs/CONCURRENCY_AND_LOCKING.md`).

## Deferred

- Install-time bootstrap hook per ADR-003.
