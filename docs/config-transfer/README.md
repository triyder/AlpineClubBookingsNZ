# Configuration Export & Import (config transfer)

> Part of the [documentation hub](../README.md).

A full-admin tool that exports a club's configuration, site content, and lodge
setup as a single portable zip bundle, and imports such a bundle into another
(or the same) instance through a plan → resolve → apply flow.

Feature issue: hoppers99/AlpineClubBookingsNZ#22 (fork). Available to full
admins at **Admin → Setup & Configuration → Export & Import**
(`/admin/config-transfer`).

For the task-focused operator walkthrough (export categories, the
plan → resolve → apply import flow, write modes, and reseal), see the
[Export & Import operator guide](../guides/config-transfer.md). This page is the
deeper reference for what each category contains and the import safety model.

## Using it

- **Export:** tick the categories to include (door codes are opt-in), download a
  `.zip` bundle.
- **Import:** upload a bundle → a mandatory **dry-run** shows exactly what will
  be created/updated per entity (plus door-code, Xero-org, and any bundle
  integrity warnings) → choose a **write mode** and (optionally) untick
  categories or resolve renames → confirm to apply. The server takes a
  `pg_dump` backup first, then in ONE transaction takes the single-flight
  advisory lock, re-plans against in-lock state, refuses on any drift, and
  applies; success and refused/failed attempts are both audited. Import
  **never deletes**, so a "restore" won't remove anything added since the
  export; the pre-apply backup is the true rollback.
- **Validation blocks apply:** every row is strictly validated at plan time —
  malformed dates, unknown enum values, non-integer/negative money, and
  invalid or reserved page slugs (the same rules the admin page editor
  enforces) are **errors** (named by file, row, and field) that disable Apply
  until the bundle is fixed (edit → reseal → re-preview). Blank cells are
  legal only where merge mode keeps an existing value. The import never
  quietly writes less, or different data, than the file says. Page paths are
  derived from the slug (never trusted from the file), and page HTML —
  including the header — is stored sanitised, exactly like the admin editor.
  Page rows also enforce the admin editor's field caps (slug/title/caption/
  menu-title lengths, header and content HTML sizes, sort-order range — the
  shared `PAGE_CONTENT_LIMITS`) and its system-page protections: a bundle
  cannot hide a page the editor refuses to unpublish (system and built-in
  pages), and cannot move a system page's fixed menu order (re-importing the
  page's current order — an instance's own export — stays clean). A
  cross-instance transfer therefore errors on a system page (e.g. `home`) whose
  bundled sort order is neither the fixed order nor the target's current
  order — normalise the system pages' sort order on both instances first.
  Keyed site-content rows (the footer sections) enforce the same content-HTML
  size cap as their admin route (the shared `SITE_CONTENT_LIMITS`), and their
  key must be one of the recognised site-content keys (the shared
  `SITE_CONTENT_KEYS`, matching the admin route's enum) — an unknown key is a
  clean row error, never a Prisma enum exception.
- **Door codes:** the dry-run prominently names each lodge whose door code the
  import would set or change, and the audit records which lodges' codes were
  actually written (never the values). Reseal recomputes the bundle's
  door-code flag from the actual files.
- **Renames (match picker):** an unmatched season, chore template, or induction
  template offers a picker — *create new* (default) or *match an existing row*
  (declaring it renamed). Resolutions re-preview and are bound into the
  fingerprint.
- **Import category selection:** untick any of the bundle's categories at
  preview to import a subset (e.g. skip Xero config after a cross-org
  warning); the selection re-previews and is fingerprint-bound.
- **Write mode (per import, default Merge):** *Merge* writes only the fields
  that carry a value in the bundle — blank/omitted fields keep the record's
  existing value, so a partial or skeleton bundle patches rather than wipes.
  *Overwrite* makes the bundle fully define each record (blank fields clear the
  value). Creates always use the bundle's values in either mode. The **dry-run
  is mode-aware**: it shows the exact fields that will change for the selected
  mode (and marks no-change rows "unchanged"); switching mode re-previews.
- **Hand-editing:** bundles are meant to be edited (e.g. tweak a CSV, add a
  lodge folder). The manifest's per-file checksums and row counts are
  **advisory** — a mismatch is surfaced as a dry-run warning, never a hard
  rejection, and the import reads the files actually present (files-first).
  "Reseal edited bundle" regenerates the manifest so an edited bundle validates
  clean again. Only structural/safety problems (not a zip, missing/invalid
  manifest, a newer format version, resource caps — enforced BEFORE inflation —
  or unsafe entry paths) are hard-refused. Re-zip mistakes are forgiven (a
  single wrapper folder is stripped, macOS cruft ignored) and anything
  discarded or uncovered warns loudly: a file outside the wrapper, or files
  present for a category the manifest doesn't include, can't be silently
  believed imported.

## Implemented categories

- **site-content** — CMS pages, keyed site content, club theme; embedded images
  travel in the bundle and their `/api/images/<id>` references are remapped on
  import.
- **club-settings** — the club-wide settings singletons (modules, booking
  defaults, member-fields, bed-allocation, booking-request, IB payments, club
  identity (name/short name/hut-leader label), email message settings, group
  discount, membership nomination/lockout/cancellation). Applying the bundle
  refreshes the DB-first club-identity cache so imported identity takes effect
  immediately.

  **Field-level allowlisting is audited in both directions (#2178).** Each
  singleton exports only the columns in its `fields` allowlist; every other
  column is named in a per-model `excluded` set with a one-line reason, and two
  drift tests guard both directions — `fields ⊆ columns` (no allowlist names a
  dropped column) and `columns ⊆ fields ∪ excluded` (no column is silently
  never exported). A newly added column therefore fails the reverse test until
  someone classifies it as should-travel or deliberately-excluded. Deliberately
  excluded: the singleton primary key, the `updatedByMemberId` audit FK, and the
  `createdAt`/`updatedAt` timestamps (all instance-local, `COMMON_EXCLUDED_COLUMNS`);
  the retired `ClubModuleSettings.multiLodge` flag; the phase-7 `lodgeId`
  soft-links; `GroupDiscountSetting.rateMembershipTypeId` (an instance-local FK);
  and the two auth-provider sign-in toggles `ClubModuleSettings.magicLink` /
  `googleLogin` (a per-install auth decision; note the login/profile pages
  render these affordances off the flag alone, so an imported `true` on an
  unconfigured target would surface a broken sign-in path — travelling them
  would first need a credential-presence render gate).
  `MembershipLockoutSettings.useFeeScheduleItemCodes` (#2109) is
  classified should-travel and now exports like the rest of that singleton.

  **A singleton the source club never saved is still exported (#2171).** Every
  entry in `SINGLETONS` always produces its JSON file; where the `id = "default"`
  row is absent the exporter emits the **effective defaults** — the values the
  app's own read path synthesises on a miss — so the bundle carries what the
  source club actually runs on and an import reproduces it instead of leaving
  the target's existing row alone. Each spec declares those defaults by
  importing the same constant its getter reads
  (`src/config/club-settings-defaults.ts`, plus the long-standing
  `DEFAULT_MODULE_SETTINGS` and `DEFAULT_MEMBER_FIELDS_SETTINGS`); a second
  hand-written copy in the exporter is the failure mode that shape exists to
  prevent, and a test fails if a spec leaves a field without a declared default.

  Be precise about what this does and does not buy:

  - `club-identity-settings` and `email-message-setting` deliberately export
    **all-null** rather than a value. Every column on those two is a nullable
    override resolved through the install's own `config/club.json`/environment
    fallback chain, so "never saved" means "no override" (exactly what their
    admin GETs synthesise) and the fallback identity belongs to the install, not
    to the club's portable configuration. Exporting it would rename the target
    club and repoint its public URL. `DEFAULTS_INTENTIONALLY_PARTIAL` names the
    two and the coverage test allows only them. This is narrowly about the
    NEVER-SAVED case only: whenever the source's row DOES exist its identity
    fields are ordinary allowlisted fields and **travel normally** — which is
    the intended behaviour, and why applying a bundle refreshes the DB-first
    club-identity cache. On any booted install the row usually does exist:
    `clubIdentitySelfHealStep` (`src/lib/config-self-heal.ts`) creates it at
    boot from `config/club.json`.
  - **An all-null file never creates a row.** `carriesNoValue` in
    `club-settings.ts` skips the create branch (and the plan reports
    `unchanged`) when every allowlisted value in the file is null, in BOTH
    modes. Only the two singletons above can produce such a file. This is not a
    tidiness rule: `clubIdentitySelfHealStep.isPresent` keys purely on the
    `ClubIdentitySettings` ROW existing, and the self-heal runner is skipped
    entirely while `clubConfigSource !== "primary"` on the documented promise
    that it repairs itself on a later boot. An import onto a SAFE_DEFAULT
    install would otherwise plant an all-null row that satisfies that presence
    check forever, so identity would never be healed once `config/club.json`
    was fixed.
  - **Merge mode still ignores blank bundle values** (`updateDataForMode` /
    `rawHasValue`), so those all-null identity entries only clear an EXISTING
    target row's overrides in **overwrite** mode. Booleans and zeroes are
    non-blank and do travel in both modes.
  - **Row existence is no longer preserved.** Importing now MATERIALISES a
    singleton the source never saved, and **four** setup-readiness signals key
    on the row existing rather than on its values. Three are booleans in the
    snapshot (`src/lib/setup-readiness-db.ts`): `bookingDefaultsConfigured`,
    `groupDiscountConfigured`, `membershipCancellationSettingsConfigured`. The
    fourth is in the consumer: the **Module Controls** step reads
    `Boolean(db.adminModuleSettings)` directly (`src/lib/setup-readiness.ts`),
    so an import flips it from *warning* to "Admin Modules activation was
    checked." That step is `required: false`, so it downgrades a warning rather
    than gating readiness. A target club's checklist can therefore report
    booking policies, membership cancellation and module activation as
    configured when nobody configured them. The effective settings are
    unchanged; only the "has an admin been here?" signal is. This is the cost
    the owner accepted on #2171 — bundles get larger and carry rows that were
    never explicitly configured.
  - **One admin-screen affordance disappears with it.** The group-discount card
    treats an unsaved singleton as dirty (`group-discount-section.tsx`, #2142)
    so an admin can create the row while happy with every default. Once an
    import has materialised `GroupDiscountSetting` the GET returns
    `configured: true`, so a pristine card's **Save** is disabled where it used
    to be enabled. Benign — the affordance existed only to create the row, which
    now exists — but it is a visible behaviour change, not purely a checklist one.
  - **A materialised row stops tracking the code default.** Once written, a
    later release that changes the built-in default does not reach that club.
  - **No format-version bump.** `CONFIG_TRANSFER_FORMAT_VERSION` stays `1`: the
    file shape is unchanged and only completeness improved. The importer is
    files-first, so an older bundle that omits a singleton still imports and
    leaves that singleton untouched — covered by a test.
- **lodge-config** — lodges, rooms, beds, seasons, season rates, lodge
  instructions (content images bundled + remapped), and chore templates. Each
  lodge is a **self-contained folder**, `lodge-config/lodges/<slug>/` with a
  `lodge.json` descriptor (slug, name, active, travel note, `isDefault`, door
  code if opted in) plus `rooms.csv` / `beds.csv` / `seasons.csv` / `season-rates.csv` /
  `instructions.csv` / `chore-templates.csv`. The lodge a row belongs to is
  **implied by its folder**, not a CSV column, so a whole lodge is easy to add,
  curate, or spot as a unit. The full per-lodge file set is always emitted
  (header-only when a collection is empty) so a folder captures the entire
  lodge config and the format is discoverable for hand-authoring.
  `season-rates.csv` is keyed by membership type (#1930, E4):
  `seasonName, membershipTypeKey, ageTier, pricePerNightCents` — a blank
  `ageTier` is a flat type's single all-ages rate. Only rate-bearing types are
  emitted (every `MEMBER_RATE` type plus `NON_MEMBER`). The old-bundle import
  compat for the legacy `seasonName, ageTier, isMember, pricePerNightCents`
  shape **closed one release after the E13 contraction (#2131)**: such a bundle
  is now **rejected** on import with a clear validation error (re-export it from
  an install running the current release, or hand-fix it with the
  [conversion recipe](../guides/config-transfer.md#converting-a-legacy-bundle-by-hand)).
  **v0.12.2 was the last release that could import the
  legacy `isMember` shape.** Instructions
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
- **membership-fees** — the membership **fee schedules** (#1941): joining fees
  (`JoiningFee`, #1931/E5) and annual membership fees with their invoice-line
  components (`MembershipAnnualFee` + `MembershipAnnualFeeComponent`, #1932/E6).
  Three CSVs, each keyed by an explicit natural key (never a database id) and
  exported in a deterministic, install-independent order so
  export→import→export is byte-stable; money stays in integer cents throughout:
  - `membership-fees/joining-fees.csv` —
    `membershipTypeKey, ageTier, effectiveFrom, effectiveTo, amountCents`;
    natural key `membershipTypeKey × ageTier × effectiveFrom` (a blank `ageTier`
    is a flat-fee type's single NULL-tier window, e.g. the built-in Family type).
  - `membership-fees/annual-fees.csv` —
    `membershipTypeKey, ageTier, effectiveFrom, effectiveTo, amountCents,
    billingBasis, prorationRule`; natural key
    `membershipTypeKey × ageTier × effectiveFrom` (#2067; a blank `ageTier` is
    the flat, whole-type fee, and a blank `prorationRule` defaults to `NONE`). A
    `PER_FAMILY` fee must be flat — a per-family row with a non-blank `ageTier`
    is a blocking row error. A pre-#2067 bundle without the column imports every
    row as flat.
  - `membership-fees/annual-fee-components.csv` —
    `membershipTypeKey, ageTier, effectiveFrom, label, amountCents, prorate,
    xeroAccountCode, xeroItemCode, sortOrder`; natural key
    `(parent fee = membershipTypeKey × ageTier × effectiveFrom) × label`. Each
    row is one Xero invoice line.

  Referenced membership types must already exist on the target (matched by
  `key`) — membership types themselves are not transferred (they are managed on
  the Membership Types page); an unknown key is a blocking row error, exactly
  like the season-rates and item-code categories. The **#1932 component
  invariant** is enforced at plan time against the bundle's own amounts: a
  `NO_INVOICE` fee is a zero total with **no** components; every invoiceable fee
  carries ≥1 component whose amounts sum **exactly** to the fee total. An
  annual-fee row must therefore always travel with its full component set (as
  the export always emits), and components whose parent fee is absent from the
  bundle are a clean error. Apply is **upsert-only** (like every category):
  joining fees and annual fees upsert by their natural key; components upsert by
  `(parent fee, label)`. A component the bundle drops on an existing install is
  **not** deleted (config transfer never deletes) — remove a component from a
  fee on the Fees page, not by re-import.

  **Precedence over the #1931 item-code path:** when a bundle carries
  `membership-fees/joining-fees.csv`, its joining-fee schedule is authoritative,
  so the **xero-config item-code-amount joining-fee materialisation is
  suppressed** (it would otherwise invent/duplicate `JoiningFee` windows from
  the item-code `amountCents` column). A bundle without `joining-fees.csv`, or
  one imported with membership-fees deselected, keeps the item-code fan-out so
  its joining fees are not silently dropped.
- **xero-config** — Xero account mappings and item-code mappings. HUT_FEE item
  codes are keyed by membership type (#1930, E4): `item-code-mappings.csv` is
  `category, membershipTypeKey, ageTier, seasonType, entranceFeeCategory,
  itemCode, amountCents` (membershipTypeKey is HUT_FEE-only; blank for
  JOINING_FEE). Frozen legacy `isMember`-keyed HUT_FEE rows are not exported.
  The old-bundle import compat **closed one release after the E13 contraction
  (#2131)**: a bundle carrying the legacy `isMember` HUT_FEE column, or the
  pre-#1931 `ENTRANCE_FEE` category name, is now **rejected** on import with a
  clear validation error rather than silently mapped/normalised — **v0.12.2 was
  the last release that could import that shape** (re-export from an install
  running the current release, or hand-fix it with the
  [conversion recipe](../guides/config-transfer.md#converting-a-legacy-bundle-by-hand)).
  Relatedly, a `HUT_FEE` row with a **blank `membershipTypeKey`** is now a
  blocking row error too: the export always emits the key, and writing a keyless
  row would create a frozen-legacy-shaped mapping the runtime never reads (and
  which would re-create on every import). Because the runtime no longer reads item-code-mapping `amountCents`
  for joining fees, any imported `JOINING_FEE` amount whose category has **no
  covering `JoiningFee` window** on the target is **materialised into open
  JoiningFee windows** using the migration's D-R1 fan-out (per-tier to every
  liable membership type; FAMILY as the Family type's flat fee), bounded to the
  day before any future window. Categories with a covering window are left
  alone. A bundle carrying the first-class **membership-fees** category's
  `joining-fees.csv` (#1941) supersedes this fan-out — the schedule there is
  authoritative, so the item-code fan-out is skipped to avoid duplicating/skewing
  it. The source Xero org id is recorded in a
  category-local `xero-config/source.json` (sealed with the rest of the category,
  not the manifest); the plan warns on an org mismatch so codes are verified
  before applying.

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
  roles, induction templates, membership fee schedules (joining fees, annual
  fees and their invoice-line components), Xero configuration mappings.
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
- [ADR-003 — Install-time bootstrap integration](decisions/ADR-003-install-seed-integration.md) (implemented, #1988)

## Implementation notes

- The import plan is **stateless**: computed for the dry-run, returned to the
  client, and re-derived at apply time. A **fingerprint** of the touched rows is
  taken at plan time and re-checked at apply; if the database changed in between,
  the apply is refused and the admin re-runs the dry-run (ADR-002). No schema
  migration is required.
- Single-flight import lock: `pg_advisory_xact_lock(hashtext('config-transfer-import'))`
  (see `docs/CONCURRENCY_AND_LOCKING.md`).

## Boot-time bootstrap auto-import (DR / clone, ADR-003, #1988)

For disaster recovery or seeding a replacement instance, a bundle can be applied
**non-interactively at boot** instead of through the admin UI. Set
`CONFIG_BUNDLE_IMPORT_PATH` to a readable bundle file: on the next Node boot —
after migrations, base seed, and the C2 self-heal — the app applies that bundle
**iff the database is empty of non-seed configuration**, through this same
validated pipeline (`src/lib/config-transfer/bootstrap-import.ts`).

- **Empty-target only, fail closed.** "Empty of non-seed configuration" means
  the pristine post-seed state with **no operator footprint** — six signals,
  ALL of which must be absent: no prior config import (interactive or
  bootstrap), no bookings, no non-system members, the setup wizard never
  finished, the setup wizard never even driven (no completed/skipped steps),
  and no audit-log row with a member actor (which catches direct-admin-editor
  configuration). Any of those present → the import is **refused** and nothing
  is written. A malformed/tampered/oversized bundle, an unreadable path, a
  probe error, or any apply failure also refuses; boot always continues. This
  includes a **legacy bundle** (#2131): it fails plan-time validation, so the
  bootstrap refuses (`refused-invalid`), writes nothing, and the replacement
  install comes up **unconfigured** — the only signal is the boot log line
  naming the first validation error, so keep the bundle at
  `CONFIG_BUNDLE_IMPORT_PATH` in the current export shape. (A
  plain "the plan has no updates" check is deliberately NOT used — the base
  seed pre-creates the config rows the bundle touches, so a legitimate
  bootstrap always shows updates; see ADR-003 "Empty-target definition".)
- **Race-safe.** The emptiness probe is re-run INSIDE the apply advisory lock
  before anything is written, and the idempotence marker commits in the same
  transaction as the config writes — so concurrent replica boots apply exactly
  once (the losers log a calm INFO refusal; see `DEPLOYMENT.md` "Expected
  logs").
- **Rename abort (reachable).** The seed creates key-weak defaults (induction
  template, example chore templates); a bundle whose source renamed them
  produces rename candidates that need a human, so the bootstrap aborts
  (`refused-invalid`, nothing written) and enumerates the entities in the log.
  Fallback: import the bundle interactively via Admin → Setup & Configuration →
  Export & Import and resolve the renames there.
- **Not gated on config provenance.** The bundle is the config source in a DR
  restore where `config/club.json` may be absent, so — unlike the self-heal —
  this import runs regardless of `clubConfigSource`.
- **Pre-apply backup waived (only here, type-enforced).** An empty database has
  nothing to protect; the waiver requires a branded proof object only the
  positive empty-target probe can mint, so no other caller compiles. Every
  other ADR-002 safeguard (validation, allowlist, DMMF type-checks,
  single-flight lock, fingerprint drift refusal, atomic upsert-only
  transaction, audit) still applies.
- **Audited + idempotent.** A success writes a `configuration.bootstrap_imported`
  audit row in the apply transaction (system/deploy actor, bundle sha256,
  outcome; shown as "System" in the admin audit log); a second boot with the
  same variable set sees that marker and refuses calmly without touching the
  bundle file.

Operator runbook and expected logs: `DEPLOYMENT.md` → "Config Bundle Auto-Import
On Boot (DR / clone)".
