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
- **lodge-config** — lodges, rooms, beds, seasons, season rates, lodge
  instructions (content images bundled + remapped), and chore templates (foreign
  keys carried as natural keys — lodge slug, room/season name).
- **committee** — role definitions + the legacy standalone committee members
  (the member-linked assignment style stays out; members are excluded).
- **induction** — induction checklist templates with their nested sections and
  items (as JSON documents; member-specific results excluded).
- **xero-config** — Xero account mappings and item-code mappings. The manifest
  stamps the source Xero tenant; the plan warns on an org mismatch so codes are
  verified before applying.

Intentionally excluded / deferred:

- Per-lodge capacity / `LodgeSettings` — the `id="default"`-vs-`lodgeId` storage
  duality is unsafe to round-trip; set it on the lodge page (ADR-001).
- Cancellation / booking-period / minimum-stay policies — these use
  replace-the-whole-tier-set semantics that conflict with the upsert-only model
  and touch refund maths, so they are deferred rather than risk a subtly wrong
  refund configuration.
- Xero contact-group rules / accepted groups — FK to member types / age-tier
  settings and are Xero-org-specific.

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
