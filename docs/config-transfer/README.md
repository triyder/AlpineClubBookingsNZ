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
  be created/updated per entity (plus door-code, Xero-org, and any bundle
  integrity warnings) → choose a **write mode** → confirm to apply. The server
  takes a `pg_dump` backup first, applies inside one transaction under a
  single-flight advisory lock, and audits the result. Import **never deletes**,
  so a "restore" won't remove anything added since the export; the pre-apply
  backup is the true rollback.
- **Write mode (per import, default Merge):** *Merge* writes only the fields
  that carry a value in the bundle — blank/omitted fields keep the record's
  existing value, so a partial or skeleton bundle patches rather than wipes.
  *Overwrite* makes the bundle fully define each record (blank fields clear the
  value). Creates always use the bundle's values in either mode.
- **Hand-editing:** bundles are meant to be edited (e.g. tweak a CSV, add a
  lodge folder). The manifest's per-file checksums and row counts are
  **advisory** — a mismatch is surfaced as a dry-run warning, never a hard
  rejection, and the import reads the files actually present (files-first).
  "Reseal edited bundle" regenerates the manifest so an edited bundle validates
  clean again. Only structural/safety problems (not a zip, missing/invalid
  manifest, a newer format version, size/count caps, or unsafe entry paths) are
  hard-refused.

## Implemented categories

- **site-content** — CMS pages, keyed site content, club theme; embedded images
  travel in the bundle and their `/api/images/<id>` references are remapped on
  import.
- **club-settings** — the club-wide settings singletons (modules, booking
  defaults, member-fields, bed-allocation, booking-request, IB payments, email
  message settings, group discount, membership nomination/lockout/cancellation).
- **lodge-config** — lodges, rooms, beds, seasons, season rates, lodge
  instructions (content images bundled + remapped), and chore templates. Each
  lodge is a **self-contained folder**, `lodge-config/lodges/<slug>/` with a
  `lodge.json` descriptor (slug, name, active, travel note, door code if opted
  in) plus `rooms.csv` / `beds.csv` / `seasons.csv` / `season-rates.csv` /
  `instructions.csv` / `chore-templates.csv`. The lodge a row belongs to is
  **implied by its folder**, not a CSV column, so a whole lodge is easy to add,
  curate, or spot as a unit. The full per-lodge file set is always emitted
  (header-only when a collection is empty) so a folder captures the entire
  lodge config and the format is discoverable for hand-authoring. Instructions
  are two-level: the top-level `lodge-config/instructions.csv` holds the
  **club-wide base** shown for every lodge, while a lodge folder's
  `instructions.csv` holds that lodge's **overrides** of the same keys.
- **committee** — the `CommitteeRole` definitions only (the new, live
  role/assignment model's config). The legacy standalone committee directory
  (`CommitteeMember`) is **not** transferred — it is a migration aid, not
  ongoing config — and member-linked `CommitteeAssignment`s stay out because
  they reference real members.
- **induction** — induction checklist templates with their nested sections and
  items (as JSON documents; member-specific results excluded).
- **xero-config** — Xero account mappings and item-code mappings. The source
  Xero org id is recorded in a category-local `xero-config/source.json` (sealed
  with the rest of the category, not the manifest); the plan warns on an org
  mismatch so codes are verified before applying.

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
