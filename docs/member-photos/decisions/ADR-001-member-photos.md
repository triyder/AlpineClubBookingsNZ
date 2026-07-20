# ADR-001: Member photos — storage, visibility, and merge handling

**Status:** Accepted — implemented across MP1–MP5 (epic delivered on `feature/member-photos`, 2026-07-21)
**Issue:** fork [#189](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/189) (MP1), epic [#171](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/171)
**Deciders:** fork owner (Daniel — design decisions on epic #171, 2026-07-15; client-side resize decision 2026-07-16), implementation agent (MP1–MP6)

## Context

Epic #171 adds member photos so the member area can put a face to a name and so
the public committee page can source its photos through the existing
member-linked `CommitteeAssignment` system. The owner fixed the design up front
(#171, "Owner decisions"); this ADR records those decisions plus the
coordination points MP1 (schema foundation) must lock down for the later
children (MP2 serving/upload, MP3 profile UI, MP4 admin UI, MP5 committee page,
MP6 docs).

The club stores content images as `MediaImage` rows (bytes in Postgres, so they
survive redeploys). The website content picker (`/api/admin/image-library`)
lists `MediaImage` and, before MP1, returned **all** rows unfiltered. Member
photos must not leak into that picker, must not be blindly served through the
public `/api/images/[id]` path, and must interact correctly with the additive,
master-wins member merge (E11, `src/lib/member-merge.ts`), which hard-deletes
the loser member inside one transaction.

## Decision

### 1. Storage — on `Member`, via a kind-discriminated `MediaImage`

- `Member.photoImageId String?` — nullable FK to `MediaImage`, `onDelete:
  SetNull` (deleting the blob clears the pointer rather than blocking).
- `Member.photoUpdatedAt DateTime?` and `Member.photoUpdatedByMemberId String?`
  — audit columns mirroring the existing `SiteBanner.updatedByMemberId` pattern.
  `photoUpdatedByMemberId` is an **FK-less snapshot** (no `@relation`), not a
  Member self-relation, so it never enters the merge relation universe.
- `MediaImageKind` enum `{ CONTENT, MEMBER_PHOTO }`; `MediaImage.kind
  MediaImageKind @default(CONTENT)`. Every pre-existing row is `CONTENT`.
- Indexes: `MediaImage.@@index([kind])` (picker filter + member-photo lookups)
  and `Member.@@index([photoImageId])` (own-photo serving, committee fan-out).

Rationale: reuses the proven bytes-in-DB `MediaImage` pattern, keeps member
photos discoverable by a single indexed FK, and adds a discriminator rather than
a separate table so serving/upload can share the existing plumbing while staying
cleanly partitioned.

### 2. Picker isolation

`/api/admin/image-library` filters both the list `findMany` and the `count` to
`where: { kind: "CONTENT" }`, and its upload `POST` stamps `kind: "CONTENT"`
explicitly. Member photos are therefore created **only** through the dedicated
member-photo endpoint (MP2) and can never surface as page-content image options.

### 3. Visibility — scoped serving, committee-gated public exposure

- A member can see (and replace/remove) **their own** photo; admins see all.
- A photo reaches the public **only** when its member has a `published`
  `CommitteeAssignment` — nothing else. Serving is a **scoped endpoint** (MP2)
  that enforces this rule; member photos must **not** reuse the public
  `/api/images/[id]` path. MP1 only lays the schema; the enforcement lives in
  MP2's serving surface with route-boundary tests and a SECURITY-ATTACK-SURFACE
  row.
- RBAC area: member photos belong to the `membership` area
  (`requireAdmin({ permission: { area: "membership", ... } })`) for admin
  management (MP4).

### 4. Consent — implied

Self-upload is the consent (the member chooses to upload their own face). The
security focus is **control** — who can set, remove, and see a photo — not
policing intended use.

### 5. Removal edge (committee members)

Allow a committee member to remove their own photo even while it is in active
public use, but **warn** ("this photo is currently shown on the public committee
page"); an admin can re-add. A hard block is the fallback only if the club later
prefers it. Finalised at MP3/MP5; MP1 imposes no DB-level block.

### 6. Committee model — member-linked only

Build exclusively on the member-linked `CommitteeAssignment` system
(`/api/committee` already reads assignments). The standalone `CommitteeMember`
model was dropped from the schema and is out of scope. Committee photos are
therefore always sourced through `Member.photoImageId`, never a committee-owned
image.

### 7. UX (later children, recorded for coordination)

In-browser zoom/crop with a **circular overlay** (area outside the circle
slightly darkened) for face positioning; the committee display gets a **square
vs circular** rendering option. Client crop → server downscale, strict
content-type allowlist, sane max size, and cached/emitted resized variants per
usage (thumbnail vs committee card). `mediaImageServingUrl`
(`src/lib/media-image.ts`) does no resize today; variant handling is MP2.

### 8. Member merge — master-wins field merge + loser-photo cleanup (this PR)

`Member.photoImageId` is an **outbound scalar FK** (Member → MediaImage), so it
is part of the additive **master-wins field merge**, *not* a re-pointed inbound
relation:

- The photo group `[photoImageId, photoUpdatedAt, photoUpdatedByMemberId]` is a
  `GROUP_FILL_SPEC` keyed on `photoImageId`. **The master keeps its own photo.**
  The loser's whole group is absorbed **only when the master has no photo**
  (`photoImageId` blank). This is the recorded master-wins decision.
- The loser's `MEMBER_PHOTO` `MediaImage` blob(s) are referenced by
  `MediaImage.uploadedByMemberId` (an FK-less snapshot column, not a relation,
  so it is neither cascaded nor moved) and by the loser's own `photoImageId`.
  On merge, `reconcileLoserMemberPhotos` hard-deletes every `MEMBER_PHOTO`
  `MediaImage` that belonged to the loser (its discarded photo plus anything it
  uploaded) **except** the one the master now keeps, so a loser member-photo can
  never survive as a dangling public asset. `CONTENT` images the loser uploaded
  are untouched (the `kind` filter); their `uploadedByMemberId` remains a
  dangling snapshot exactly like every other actor column left by the merge.
  Deleting a blob the loser still points to is safe because `photoImage` is
  `onDelete: SetNull`.
- The completeness/DMMF guard (`member-merge-dmmf.test.ts`) is unaffected:
  `Member.photoImage` is typed `MediaImage?` (not a Member relation), and
  `MediaImage.photoOfMembers` is a `Member[]` list back-ref (owns no FK), which
  the existing `Member[]` skip in the DMMF cross-check already excludes. Both new
  snapshot columns are added to `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`.

### 9. Migration — expand-only

One expand-only migration (`20260721110000_add_member_photos`): `CREATE TYPE`
for the enum, three nullable `ADD COLUMN`s on `Member` (no default), one `NOT
NULL DEFAULT 'CONTENT'` column on `MediaImage` (constant default →
metadata-only, no rewrite), two plain btree indexes, and one nullable FK
`ON DELETE SET NULL`. Old-colour compatible (the prior client never reads the
new columns; every image stays `CONTENT`). A blue/green ledger row is recorded
in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.

## Security considerations

- **Least exposure by default.** The `kind` discriminator plus the picker filter
  mean a member photo is invisible to content admins by default; public exposure
  is opt-in via a `published` `CommitteeAssignment` and enforced at serving time
  (MP2), never by reusing the public image path. MP1 makes the wrong thing hard
  by construction (separate kind, scoped index) but does not itself serve bytes.
- **No orphaned public asset after merge.** `reconcileLoserMemberPhotos` deletes
  the loser's unreferenced `MEMBER_PHOTO` blobs inside the merge transaction, so
  a merge cannot leave a member-photo blob addressable with no owning member.
- **Auditability.** `photoUpdatedByMemberId`/`photoUpdatedAt` record who set a
  photo; the merge audit (`MEMBER_MERGED`, critical) now carries a
  `photoReconcile` count.
- **Privacy Act alignment.** Implied consent is self-upload; control (set /
  remove / see) is the enforced boundary. Removal is always permitted (warn, not
  block) so a member is never locked out of removing their own image.
- **Deferred to MP2 (called out so it is not lost):** strict content-type
  allowlist, max size, server downscale, and route-boundary tests on the scoped
  serving/upload endpoints, plus their SECURITY-ATTACK-SURFACE rows.

## Consequences

- MP2+ can rely on a stable storage contract: `Member.photoImageId` +
  `MediaImage.kind = MEMBER_PHOTO`, served only through the scoped endpoint.
- The content picker is now partitioned; any future uploader that must create a
  member photo has to set `kind = MEMBER_PHOTO` and will be excluded from the
  picker automatically.
- Member merge is photo-correct: master-wins, no orphan, DMMF guard green.
- Follow-up children (#190–#194) implement serving, UI, and the committee page;
  MP6 (#194) finalises docs and this ADR's downstream references.

## Implementation status (as built, MP1–MP5)

Delivered on `feature/member-photos`. The decisions above hold as built, with
these clarifications where the implementation refined a forward-looking note:

- **Resize (refines decision 7).** The owner chose **client-side resize with no
  new server dependency** (2026-07-16). As built: the crop UI (MP3/MP4)
  downscales to a **512×512 square** on an in-browser canvas and uploads that;
  the server (MP2) validates (magic-byte JPEG/PNG/WebP allowlist, 2 MB cap,
  4096 px backstop) and stores the bytes verbatim. There is **no server-side
  image library, no server downscale, and no per-usage resized variants** — the
  single stored square is rendered at CSS sizes (circular/square via
  `border-radius`). Decision 7's "server downscale / cached variants" language is
  superseded by this.
- **Crop UI is shared (MP3 + MP4).** `MemberPhotoEditor`
  (`src/components/member-photo-editor.tsx`) is the one crop/upload/remove
  component, used self-service on the profile page and by admins (on behalf,
  gated on `membership:edit`, fail-closed on the loading tri-state) on the
  member-detail page. `ProfilePhotoSection` is a thin self-mode wrapper.
- **Serving authz (MP2).** Public exposure requires the member be **active** and
  hold an active, published `CommitteeAssignment` — kept in lockstep with
  `/api/committee` (a deactivated member with a stale published assignment is
  **not** public). 404 is preferred over 403 so a private photo's existence is
  never confirmed. Full matrix in `SECURITY-ATTACK-SURFACE.md`.
- **Committee roster display (MP5).** A `PublicContentSettings.committeePhotoDisplay`
  setting (`NONE` default / `CIRCLE` / `SQUARE`) governs whether the public
  committee roster renders photos and their shape. This is **presentational**:
  it gates the roster render and whether `/api/committee` emits per-member photo
  metadata; it does **not** change the serving rule (a published committee
  member's photo remains servable through the scoped endpoint). `NONE` is a
  privacy-safe opt-in; members without a photo show an initials placeholder.
- **Migration.** Shipped as `20260721110000_add_member_photos` (re-timestamped
  during the upstream sync to append after the merged history), plus
  `20260721120000_add_committee_photo_display` (MP5). Both expand-only with
  blue/green ledger rows.
