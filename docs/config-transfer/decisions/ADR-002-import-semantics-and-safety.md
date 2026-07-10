# ADR-002: Import Semantics and Safety Model

## Status

Proposed (owner-reviewed direction, 2026-07-08; to be Accepted with the first
implementing PR). Feature issue: hoppers99/AlpineClubBookingsNZ#22.

## Context

An import can rewrite club-wide behaviour (module flags, capacities, booking
policies) and content on a live site. Interactive decisions are required for
ambiguous matches (ADR-001's key-weak entities) and for conflicts, but user
interaction cannot happen inside a database transaction. The bundle is
hand-editable and therefore untrusted. The club owner's requirements:
idempotent imports, a mandatory dry-run with a full itemised preview, an
automatic database backup before apply, and user-driven resolution of
anything uncertain or destructive.

## Decision

### Upsert-only, never delete

For every row: match by natural key (or candidate match for key-weak
entities) → update if found, create if not. **Import never deletes.**
Importing a two-lodge bundle twice yields two lodges; importing a one-lodge
bundle into a two-lodge site updates the matching lodge (or creates a third),
never removes one. A mirror/replace mode is explicitly deferred; if ever
added it must be reference-aware (refuse to delete config referenced by live
rows — e.g. `ChoreAssignment → ChoreTemplate` is `onDelete: Restrict`).

**Stated limitation (must appear in UI copy):** because import never
deletes, "restoring a snapshot" is approximate — anything added after the
snapshot survives. True point-in-time rollback is the automatic pre-apply
database backup, not this tool.

### Plan → resolve → apply

1. **Plan (dry-run, mandatory).** Parse and validate the bundle; compute a plan:
   every action (create / update / unchanged), any warning, and any **blocking
   validation error** — every row is strictly validated (dates, enum values
   against the generated Prisma enums, money as non-negative integer cents;
   blank cells only where merge keeps an existing value) and failures are named
   by file/row/field. **Errors disable apply** until the bundle is fixed
   (edit → reseal → re-preview); the import never writes less or different data
   than the file says. The plan also carries a **fingerprint** binding the
   touched rows' current DB state PLUS the bundle bytes (sha256), the write
   mode, the category selection, and any match resolutions — so apply refuses
   not just DB drift but a substituted bundle, a switched mode, or unpreviewed
   resolutions. The plan is **stateless** — returned to the client, not
   persisted. (An earlier draft persisted the plan in a new table; re-deriving
   under the fingerprint meets the same safety goals without a schema
   migration.)
2. **Resolve.** The admin answers the open questions in the UI:
   - unmatched key-weak row (season, chore template, induction template) → a
     **match picker**: *create new* (default) or *match to existing X*,
     declaring the bundle row a rename of that row (the match then updates it,
     including the name). Resolutions re-run the preview and are bound into
     the fingerprint; key-strong renames (slugs, role keys) deliberately stay
     creates;
   - **write mode** (applies to every entity, chosen in the UI, default
     **merge**): in *merge*, only fields whose bundle value is present +
     non-empty are written onto an existing row, so blank/omitted fields keep
     the target's existing value (an older or partial bundle cannot wipe
     populated fields — the safe default, and what makes the always-emitted full
     skeleton safe to hand-edit); in *overwrite*, the bundle fully defines each
     row and blank fields clear the target. Creates always use the bundle's
     values regardless of mode. **The dry-run is mode-aware:** it computes the
     exact value apply would write (shared build functions, mode-filtered) and
     diffs it against the current row after canonicalising both sides to the same
     type, so it reports accurate per-field `changedFields` and reclassifies a
     no-op update as "unchanged" — no false positives on dates/enums/numbers.
     Changing the mode re-runs the preview;
   - Xero category → if the bundle's source tenant id (from
     `xero-config/source.json`, not the manifest) differs from the connected
     org (or none is connected), a prominent warning; the category checkboxes
     let the admin skip Xero (or any category) for this import, re-previewed
     and fingerprint-bound;
   - door codes → the dry-run prominently names each lodge whose door code
     would be set or changed (the manifest's export-time flag alone cannot be
     trusted for a hand-edited bundle);
   - bundle integrity → any advisory checksum/row-count/file-set drift from a
     hand-edited bundle is listed (never blocks); the admin can apply as-is or
     "reseal" to regenerate the manifest first.
3. **Apply.** Take the automatic DB backup, then in ONE transaction: take the
   single-flight advisory lock, **re-plan against in-lock state**, refuse on
   validation errors or ANY fingerprint mismatch (never apply a stale or
   substituted plan — a second import queued behind the lock re-plans against
   the winner's committed writes), then execute in dependency order (lodges →
   rooms → beds → per-lodge config; singletons independently). Any failure
   rolls back the entire import. Confident, non-destructive changes are not
   individually prompted — they are visible in the preview and covered by the
   single final confirm.

### Concurrency and access

- Imports are single-flight: apply takes a dedicated advisory lock (new lock
  family, registered in `docs/CONCURRENCY_AND_LOCKING.md` per that
  document's rule) so two admins cannot apply concurrently.
- The entire surface (export and import) is **full-admin only** — not a
  matrix-permission area, and deliberately **not a ClubModuleSettings
  module**: modules gate member-facing features, and an import can itself
  change module flags, so a module gating this tool would be
  self-referential. The later install-time hook (ADR-003) is deploy-level
  configuration, not a module.

### Selection

Per-category selection on both export and import (tick the categories to
include/apply). Per-item control is provided by the resolve step, not by
item-level tick lists.

## Consequences

- The persisted plan is simultaneously the dry-run artefact, the resolution
  worksheet, and the audit record — one model serves all three.
- Re-planning on DB drift trades a little admin friction for the guarantee
  that what was previewed is exactly what is applied.
- The pre-apply `pg_dump` backup (reusing `src/lib/backup.ts`) bounds the
  blast radius of any importer bug to "restore the backup" — this is what
  makes an interactive, behaviour-changing tool acceptable to ship
  incrementally.
- Never-delete keeps live references safe by construction, at the cost of
  the approximate-restore limitation above.

## Security Considerations

- **Untrusted input:** bundles may be hand-edited. Every file is schema/shape
  validated; page HTML passes through the same sanitiser the CMS uses;
  natural-key integrity and reference resolution are enforced before
  planning; the upload is streamed with a hard size cap.
- **Privilege boundary:** full-admin only, because import can flip module
  flags, change booking/capacity behaviour, and rewrite public content. No
  matrix role may reach it. The import can never write members, auth/role
  fields, or secrets — those fields simply do not exist in the format
  (ADR-001 allowlists).
- **Behaviour-change warnings:** the preview explicitly flags settings whose
  change alters live booking behaviour (module toggles, capacities,
  policies) so an admin cannot apply them unknowingly on an active site.
- **Auditability:** every apply records who, when, the bundle sha256, the mode
  and category selection, each resolution choice, a bounded per-item diff of
  what changed, and — for door codes — the lodges whose codes were ACTUALLY
  written (slugs only, never values). Failed/refused applies (fingerprint
  drift, validation errors, backup failure, invalid bundle, unexpected error)
  are audit-logged as `configuration.import_refused`.
- **Door codes:** absent by default; when the exporting admin opts in, the
  export UI labels the bundle as carrying physical-access information. On
  import the dry-run names each lodge whose code would change, and reseal
  recomputes the bundle's door-code flag from the actual files, so a hand-added
  code can neither apply silently nor hide behind a stale flag.
- **Denial-of-service:** entry-count, per-file, and total-uncompressed caps are
  enforced BEFORE inflation via the unzip filter (junk entries are never
  inflated), on top of the compressed upload cap — a high-ratio or many-entry
  zip cannot exhaust memory; media imports additionally enforce the library's
  2MB per-image cap and image-type sniffing at plan time.
