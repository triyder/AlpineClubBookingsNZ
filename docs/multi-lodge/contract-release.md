# Multi-Lodge Schema Tightening — status and what remains

The multi-lodge schema shipped **expand-first** (`lodgeId` added nullable and
backfilled to the sole lodge). This doc records what has since been **tightened**,
how it was done **without an outage**, and what is deliberately **left as-is**.

## Done: `lodgeId` is now `NOT NULL` on the entity tables — with no outage

Migration `20260708001100_multi_lodge_entity_lodge_id_not_null` enforces
`NOT NULL` on `lodgeId` for the six entity tables (`LodgeRoom`, `Locker`,
`Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment`).

The catch it solves: deploys are blue/green (the `migrate` container runs while
the *old* app colour still serves) and clubs **target `latest`**, so the old
colour during a cutover can be *pre-lodge* code that doesn't stamp `lodgeId`. A
naive `SET NOT NULL` would reject that colour's inserts mid-cutover (outage) or
abort the migration.

The fix is a **column default that resolves the lodge**:

```sql
CREATE FUNCTION default_lodge_id() ...   -- oldest active lodge, else oldest
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();
UPDATE "Booking" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;
ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET NOT NULL;
```

An old colour's `INSERT` omits `lodgeId` → the default fills the lodge → no null
is ever written → `NOT NULL` holds throughout the cutover, on both fresh and
existing installs. **No outage, no migration abort.** The schema declares the
default as `@default(dbgenerated("default_lodge_id()"))`, which `db:check-drift`
matches exactly. The default is kept **permanently** (harmless — new code always
stamps `lodgeId`; the default only ever fires for an old colour's omitted-column
write during a cutover). Removing it later would re-open the window and is not
planned.

**Deploy: no override needed.** The blue/green migration validator recognises the safe pattern — a `SET NOT NULL` whose same table+column also gets a `SET DEFAULT` in the same migration is old-code-compatible — so this deploys through the normal blue/green flow **without** `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS`. It still carries a documented safety-ledger row; genuinely-breaking SQL (drops, renames, type changes, or an *unmatched* `SET NOT NULL`) stays gated.

The null-tolerant code paths for these tables are now retired:
`lodgeNullTolerantScope` returns a strict `{ lodgeId }`, capacity queries scope
with a plain `lodgeId` field, and the bulk-seed / hut-leader-PIN "null clashes
everywhere" branches are gone.

## Done: club-wide policy partitions are now DB-enforced (partial unique indexes)

Migration `20260709000100_add_clubwide_policy_partial_unique_indexes` adds raw-SQL
partial unique indexes over the club-wide (null-`lodgeId`) partitions:

- `CancellationPolicy_clubwide_daysBeforeStay_unique` — `("daysBeforeStay") WHERE "lodgeId" IS NULL`
- `LodgeInstruction_clubwide_key_unique` — `("key") WHERE "lodgeId" IS NULL`

This closes the "not expressible in Prisma" deferral. The premise that a raw-SQL
partial index "would itself fail `db:check-drift`" turned out to be false in
practice: `prisma migrate diff` does not surface partial indexes it cannot
express in PSL, so the drift gate stays green — the same precedent as the
long-standing `Member_email_primary_unique` / `Member_email_login_unique`
indexes and the `XeroSyncOperation` ACTIVE-per-correlation index (#1354). The
trade-off is that these indexes are **invisible to Prisma tooling**: they exist
only in the migration SQL and in schema comments on the two models. CI guards
them (issue #1664): the migration-drift job applies the migrations and asserts
every partial index against the committed manifest
`prisma/partial-unique-indexes.tsv` — update the manifest in the same PR as any
intentional change.

The migration dedupes each null partition first (keeping the most recently
updated row) so the index build cannot abort a deploy, though app-side
enforcement (the cancellation route's Serializable replace transaction, the
instructions route's findFirst-then-write) should mean no duplicates exist.
App-side enforcement stays as the first line of defence; the indexes are the
backstop that was previously missing. Old colours during a blue/green cutover
already enforce the same uniqueness app-side, so the indexes reject nothing an
old colour legitimately writes.

## Done: `EmailMessageSetting` lodge-identity columns dropped — identity resolves from `Lodge`

Migration `20260709130000_drop_email_message_setting_lodge_identity_columns`
drops `EmailMessageSetting.lodgeName / lodgeTravelNote / doorCode`. It landed
with the code refactor it required: `loadEmailMessageSettingsForLodge` now
**always** resolves a lodge and reads name / travel note / door code from the
`Lodge` table — the explicit booking lodge when given, otherwise the club's
**default lodge** (the `Lodge.isDefault` flag, else oldest active, else oldest —
the same resolution as `getDefaultLodgeId` and the SQL `default_lodge_id()`
function; see the MIRROR CONTRACT comment in `src/lib/lodges.ts`). The
club-level fields (club name, bookings name, sender name, support / contact
email, public URL) stay on the singleton. `loadEmailMessageSettings()` now
delegates to `loadEmailMessageSettingsForLodge(null)`, and the compatibility
mirror `syncSoleActiveLodgeIdentity` is retired.

The drop is **value-dead** after the same-release refactor — nothing reads the
columns' values anymore. The migration **backfills first** so no admin-entered
value is lost: it copies the singleton's `lodgeTravelNote` / `doorCode` onto the
default lodge wherever that lodge's own columns are still NULL. `lodgeName` is
not backfilled — `Lodge.name` is NOT NULL and authoritative, so a divergent
email-only lodge name is superseded by design.

**Deploy: breaking-gated.** The columns stayed in the Prisma model until this
release, so an old colour during a cutover still SELECTs them by name on the
singleton. Member-facing sends **degrade gracefully** (the persisted-settings
loader catches the error and falls back to config defaults, and per-booking
identity already reads from `Lodge`), but the admin email-settings and
lodge-admin routes error until cutover — admin-only, brief, retryable. Deploy
with old traffic idle or drained and `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`;
the migration-ledger row records the full rationale.

## Policy tables keep nullable `lodgeId` by design

`CancellationPolicy`, `MinimumStayPolicy`, `BookingPeriod`, `LodgeInstruction`,
`BookingRequest`, and the settings singletons keep a nullable `lodgeId` where
`null` is a real value (club-wide default / no explicit lodge). These are **not**
part of the `NOT NULL` tightening; they scope via `resolvePolicyRowsForLodge`
(own row → club-wide/null fallback), not `lodgeNullTolerantScope`.
