import { Prisma, type AgeTier, type PrismaClient } from "@prisma/client";
import { clubConfig, clubConfigSource, type ClubConfigSource } from "@/config/club";
import {
  CLUB_CONFIG_LODGE_CAPACITY,
  getDefaultLodgeCapacity,
} from "@/lib/lodge-capacity";
import logger from "@/lib/logger";

/**
 * Boot-time config self-heal (epic #1943, child C2).
 *
 * The problem: a routine production deploy runs `prisma migrate deploy` ONLY.
 * `prisma/seed.ts` does NOT run, and a SQL migration CANNOT read
 * `config/club.json` (see the identity migration's own comment,
 * `prisma/migrations/20260717160000_add_club_identity_settings/migration.sql`).
 * So the obvious "backfill the DB in the same migration/seed that removes a
 * file/env fallback" is mechanically impossible on a live upgrade.
 *
 * This module is the load-bearing safety net every epic-#1943 collapse child
 * (C3/C4/C5) depends on. On every process boot it copies each registered
 * setting's CURRENT EFFECTIVE config value into its DB row **iff that row is
 * still absent**, so when a later child drops its file/env fallback the DB is
 * already populated with the club's real value.
 *
 * Guarantees:
 * - **Create-if-absent only.** Every write mirrors the create-only upsert
 *   pattern (`prisma/seed.ts` `clubIdentitySettings.upsert(update:{})` and
 *   `src/lib/config-transfer/categories/club-settings.ts`). An admin's
 *   configured value (or an intentional null on an existing row) is NEVER
 *   overwritten.
 * - **Idempotent.** A second boot is a no-op once the row is present.
 * - **Blue/green-safe.** Safe when the blue AND green slots boot at once: a
 *   concurrent writer's unique-constraint conflict (Prisma P2002) is treated as
 *   already-present, not an error.
 * - **Best-effort.** `runConfigSelfHeal` never throws — a per-step failure is
 *   logged and the remaining steps still run. The boot integration
 *   (`src/instrumentation.node.ts`) additionally wraps the call so self-heal can
 *   never block or fail startup.
 * - **Fallback-guarded.** Healing runs ONLY when the effective config came from
 *   a valid primary `config/club.json` (`clubConfigSource === "primary"`). If
 *   the config resolved to the `club.example.json` identity or the hard-coded
 *   `SAFE_DEFAULT_CONFIG` (a missing / unreadable / malformed primary — a real
 *   path: the Docker runner image does not copy gitignored `config/`, fork
 *   provisioning can fail on one boot), EVERY step is skipped. Otherwise ONE bad
 *   boot would freeze `"Example Mountain Club"` / safe-default capacity + rates
 *   into the create-if-absent DB rows, which are then DB-first authoritative and
 *   never overwritten — the exact outage class epic #1943 exists to prevent.
 *   Healing self-repairs automatically on the next boot once a valid primary
 *   config is present. Every registered step (C3/C4/C5 capacity / age-tier /
 *   rate steps included) inherits this guard automatically — it gates the whole
 *   run, not per step.
 *
 * ## Registering a new step (C3/C4/C5)
 * Add another `defineSelfHealStep({...})` to `SELF_HEAL_STEPS` below. A step
 * describes exactly three things:
 *   - `isPresent(db)`  — is the DB value already populated? (guard the write)
 *   - `currentValue()` — the current EFFECTIVE config value to persist
 *   - `write(db, v)`   — a write that MUST NOT overwrite an existing value
 *
 * ### Presence/write grain shapes — choose the one that matches the migration
 * A step's `isPresent`/`write` pair MUST agree on GRAIN, or a partial write can
 * wedge the target. Three shapes exist today; pick by what the enabling
 * migration added:
 *   1. **New TABLE / fixed-id singleton row → ROW-LEVEL.** `isPresent` checks
 *      whether the ROW exists (`findUnique` on a known id); `write` is a single
 *      create-if-absent upsert (`update: {}`) that never touches an existing
 *      row. One row, one write; nothing can be left half-written. Worked
 *      example: `clubIdentitySelfHealStep`.
 *   2. **New nullable COLUMN on an EXISTING singleton row → COLUMN-LEVEL.** A
 *      row-level check would wrongly skip every install whose row predates the
 *      new column (it would never backfill), so `isPresent` checks the COLUMN
 *      (is it non-null?). `write` is a create-if-absent row upsert (covers a
 *      brand-new install) THEN an atomic `updateMany` scoped to the null column
 *      (`where: { id, col: null }`), so it fills ONLY a still-null column and
 *      can never overwrite an admin-set value or a concurrent booter's write.
 *      Worked example: `clubFacebookUrlSelfHealStep` — copy that pattern (and
 *      read its long-form comment for why a null on a later-added column cannot
 *      be admin intent). If the target table stops being a singleton (e.g.
 *      LodgeSettings going per-lodge), drop the `id` predicate so the
 *      null-scoped `updateMany` backfills every null row, not just the default.
 *   3. **Whole-table-empty presence + ATOMIC multi-row write.** Presence is
 *      "the table is empty" (`findFirst`) but the write inserts SEVERAL rows.
 *      Worked example: `ageTierSelfHealStep`. The hazard is a grain mismatch:
 *      per-row writes under a table-grain presence check can wedge a PARTIAL
 *      set — a mid-write failure leaves e.g. INFANT+CHILD only, the next boot's
 *      `findFirst` sees rows and skips forever, and classification silently
 *      breaks. So the multi-row write MUST be all-or-nothing: wrap every row in
 *      a single `$transaction` so an interrupted heal rolls back to an empty
 *      table and the presence check retries cleanly on the next boot. Any
 *      future multi-row step MUST use this atomic shape.
 * In every shape the write must be incapable of overwriting an existing value so
 * the never-overwrite guarantee holds.
 */

/**
 * The subset of the Prisma client the self-heal steps touch. Aliased to the
 * full `PrismaClient` so real callers pass `prisma` directly; tests inject a
 * structural fake cast to this type.
 */
export type SelfHealDb = PrismaClient;

/** A typed self-heal step (see the module doc for the contract). */
export interface ConfigSelfHealStep<TValue> {
  /** Stable identifier used in logs and the run summary. */
  readonly name: string;
  /** Resolves true when the DB row is already populated (skip the write). */
  isPresent(db: SelfHealDb): Promise<boolean>;
  /** The current EFFECTIVE config value to persist when the row is absent. */
  currentValue(): TValue;
  /** Create-if-absent write. MUST NOT overwrite an existing row. */
  write(db: SelfHealDb, value: TValue): Promise<void>;
}

/**
 * A type-erased step used by the registry and runner. `defineSelfHealStep`
 * binds `currentValue` + `write` into a single `heal` closure so the registry
 * can hold heterogeneously-typed steps in one array.
 */
export interface RegisteredSelfHealStep {
  readonly name: string;
  isPresent(db: SelfHealDb): Promise<boolean>;
  heal(db: SelfHealDb): Promise<void>;
}

/** Erase a typed step's value into a `RegisteredSelfHealStep`. */
export function defineSelfHealStep<TValue>(
  step: ConfigSelfHealStep<TValue>,
): RegisteredSelfHealStep {
  return {
    name: step.name,
    isPresent: (db) => step.isPresent(db),
    heal: (db) => step.write(db, step.currentValue()),
  };
}

/**
 * True for a Prisma unique-constraint conflict (P2002). Detected both by
 * instance (`PrismaClientKnownRequestError`) and structurally (`code === "P2002"`)
 * so a raced insert is tolerated regardless of how the driver surfaces it.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P2002";
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Registered steps
// ---------------------------------------------------------------------------

// The ClubIdentitySettings singleton row id. Kept as a literal (mirrors
// CLUB_IDENTITY_SETTINGS_ID in `src/lib/club-identity-settings.ts`) so this
// boot module stays free of that module's `server-only` import — the
// out-of-band `npm run config:self-heal` tsx entrypoint imports this file, and
// a `server-only` import would abort it.
const CLUB_IDENTITY_SETTINGS_ID = "default";

interface ClubIdentitySelfHealValue {
  name: string;
  shortName: string | null;
  hutLeaderLabel: string | null;
}

/**
 * Identity step (epic #1943, child C1/#1980 — the fields the
 * 20260717160000_add_club_identity_settings migration added). Copies the
 * effective `config/club.json` identity into the ClubIdentitySettings singleton
 * iff the row is absent — the boot-time equivalent of the create-only seed
 * upsert (`prisma/seed.ts`), which never runs on a `migrate deploy`.
 */
export const clubIdentitySelfHealStep = defineSelfHealStep<ClubIdentitySelfHealValue>({
  name: "club-identity-settings",
  async isPresent(db) {
    const row = await db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { id: true },
    });
    return row !== null;
  },
  currentValue() {
    // The EFFECTIVE config identity (mirrors the seed create-only upsert).
    return {
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
    };
  },
  async write(db, value) {
    // Create-if-absent only (`update: {}`). An existing row — including one an
    // admin left partially null — is left untouched.
    await db.clubIdentitySettings.upsert({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      create: { id: CLUB_IDENTITY_SETTINGS_ID, ...value },
      update: {},
      select: { id: true },
    });
  },
});

// The legacy singleton LodgeSettings row id (mirrors LODGE_SETTINGS_ID in
// `src/lib/lodge-settings.ts`). Kept as a literal so this boot module needs no
// import of that file (which statically pulls the Prisma client). In every
// current deployment the club default lodge's capacity lives on this "default"
// row — the legacy-row branch of `updateLodgeSettings` writes it, and
// `loadLodgeCapacityOverride` reads it for the default lodge (own row absent,
// legacy row unlinked or linked to the default lodge) — so this is the row the
// capacity step heals.
const LODGE_SETTINGS_ID = "default";

/**
 * Best-effort resolution of the club default lodge id through the SelfHealDb
 * surface (`db.lodge`). Returns null — never throws — when it cannot be
 * resolved cheaply at boot: no Lodge row exists yet, or a structural test fake
 * omits the `lodge` delegate. A null result degrades the capacity heal to an
 * UNLINKED create (documented residual) rather than failing the step. Uses a
 * dynamic import so this boot module's static graph stays free of `@/lib/lodges`
 * (keeping the out-of-band `npm run config:self-heal` tsx entrypoint light).
 */
async function resolveDefaultLodgeIdSafe(db: SelfHealDb): Promise<string | null> {
  try {
    const { getDefaultLodgeId } = await import("@/lib/lodges");
    return await getDefaultLodgeId(db);
  } catch {
    return null;
  }
}

/**
 * Lodge-capacity step (epic #1943 C2 mechanism, collapse child #1982). Backfills
 * the DEFAULT lodge's `LodgeSettings.capacity` from the current club-config bed
 * total (`CLUB_CONFIG_LODGE_CAPACITY`) — but ONLY when the default lodge would
 * otherwise resolve to 0. #1982 removed the runtime `club.json` capacity
 * fallback, so without this backfill a live upgrade — which runs only
 * `prisma migrate deploy`, never the seed — would drop a Bed-Allocation-off
 * default lodge with no capacity override to capacity 0 and refuse all bookings
 * (the exact tokoroa live-safety outage this child exists to prevent). Because
 * self-heal runs on boot, the DB is populated before the removed fallback can
 * bite.
 *
 * ## The gate — heal ONLY a lodge that would otherwise resolve to 0
 * COLUMN-level presence (unlike the row-level identity step): `isPresent` keys
 * on the `capacity` COLUMN of the default lodge's row, not merely that the row
 * exists — a `LodgeSettings` row may already exist (e.g. carrying
 * `hutLeaderLookaheadDays`) with a null capacity. But a null capacity is NOT
 * always "unpopulated": on this OLD column it can be deliberate admin INTENT.
 * With Bed Allocation ON and >=1 active bed the lodge resolves to its LIVE bed
 * count and a null capacity means "no ceiling — use the bed count" (see
 * `getLodgeCapacityStatus` step 1). Writing the config bed total there would
 * install it as a per-lodge capacity OVERRIDE, which acts as a CEILING: the
 * lodge would silently resolve to `min(beds, total)` — a capacity REDUCTION that
 * violates never-overwrite-admin-intent and the "Bed Allocation on → behaviour
 * unchanged" AC. So the presence probe:
 *   1. an explicit capacity (admin-set OR previously healed) is present → skip;
 *   2. capacity IS NULL but the default lodge already resolves > 0 (Bed
 *      Allocation ON with active beds) → treated as present, NO write (the bed
 *      count is authoritative; a null there is intent, not absence);
 *   3. capacity IS NULL and the lodge resolves to 0 (Bed Allocation OFF, or ON
 *      with zero active beds — the tokoroa case) → heal.
 * The gate reuses `getDefaultLodgeCapacity`, so it can NEVER drift from the
 * frozen capacity-resolution order it mirrors. A resolution failure (e.g. no
 * Lodge row yet) degrades to "resolves to 0" → heal, matching the pre-gate
 * behaviour for an unconfigured install.
 *
 * KNOWN RESIDUAL (deliberate trade-off, see PR #1982): because module-flag read
 * errors are swallowed to defaults (`bedAllocation: false`), a transient flags
 * read failure on a genuinely Bed-Allocation-ON lodge with a deliberate null
 * capacity makes the lodge resolve 0 on that boot, so the heal fires and writes
 * a capping override that later boots will not undo (capacity is then non-null).
 * The failure direction is capacity-REDUCING (never overbooks) and
 * admin-recoverable; degrading a read error to "skip" instead would reopen the
 * cold-boot capacity-0 outage this step exists to prevent, so error→heal was
 * chosen. Revisit only with an explicit flags-read-health signal.
 *
 * ## The write — create-if-absent, null-scoped fill, linked to the default lodge
 * The write create-if-absents the legacy row and then atomically fills capacity
 * ONLY `WHERE capacity IS NULL`, so it tolerates every state safely:
 *   - no row at all               → created with the capacity,
 *   - row present, null capacity   → filled,
 *   - row with an admin-set value  → NEVER overwritten, and
 *   - concurrent (blue/green) boots → the second `updateMany` matches zero rows.
 * It also LINKS the healed row to the club default lodge (`lodgeId`), so its
 * capacity serves ONLY the default lodge and can never leak to an additional
 * lodge that lacks its own row (the #1982 additional-lodge=0 invariant — an
 * UNLINKED legacy row applies club-wide via `loadLodgeCapacityOverride`).
 * Linking is best-effort and null-scoped: a row already linked by migration
 * 20260708000100 is never re-pointed, and an unresolvable default lodge leaves
 * the row unlinked (still capacity-correct for a single-lodge club).
 * The whole-run provenance guard (see the module doc) additionally ensures this
 * only fires from a valid primary `config/club.json`.
 */
export const lodgeCapacitySelfHealStep = defineSelfHealStep<number>({
  name: "lodge-capacity",
  async isPresent(db) {
    // A 0-bed primary config has nothing meaningful to persist. Report
    // already-present (mirrors the facebookUrl step's `currentFacebookUrl()
    // === null` short-circuit) so the runner never records a phantom "healed"
    // for a write that would no-op; it self-heals later once the config gains
    // beds. Kept here (not only in write) for log honesty.
    if (!Number.isFinite(CLUB_CONFIG_LODGE_CAPACITY) || CLUB_CONFIG_LODGE_CAPACITY <= 0) {
      return true;
    }
    const row = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
      select: { capacity: true },
    });
    // (1) An explicit capacity — admin-set or previously healed — is present.
    if (row?.capacity != null) return true;
    // capacity IS NULL. (2)/(3): heal ONLY when the default lodge would
    // otherwise resolve to 0. When it already resolves > 0 (Bed Allocation on
    // with active beds), the null is deliberate "use the bed count" intent and
    // writing a capping override would silently reduce capacity — so skip. The
    // resolved figure comes from the frozen capacity-resolution order.
    try {
      const resolved = await getDefaultLodgeCapacity(
        db as unknown as Parameters<typeof getDefaultLodgeCapacity>[0],
      );
      return resolved > 0;
    } catch {
      // Unresolvable (e.g. no Lodge row yet) → treat as unconfigured → heal.
      return false;
    }
  },
  currentValue() {
    // The current EFFECTIVE club-config bed total (clubConfig.beds.reduce).
    return CLUB_CONFIG_LODGE_CAPACITY;
  },
  async write(db, value) {
    // Guarded by isPresent (a 0-bed config reports already-present); retained as
    // a defensive backstop that can never persist a non-positive capacity.
    if (!Number.isFinite(value) || value <= 0) return;
    // Resolve the default lodge id up front so both the create and the
    // null-scoped link below point the healed row at the default lodge.
    const defaultLodgeId = await resolveDefaultLodgeIdSafe(db);
    // Create-if-absent the legacy default row (mirrors the create-only upsert
    // the seed / updateLodgeSettings use: `update: {}` never touches an existing
    // row), then fill the capacity column atomically and only while still null.
    await db.lodgeSettings.upsert({
      where: { id: LODGE_SETTINGS_ID },
      create: { id: LODGE_SETTINGS_ID, capacity: value, lodgeId: defaultLodgeId },
      update: {},
      select: { id: true },
    });
    await db.lodgeSettings.updateMany({
      where: { id: LODGE_SETTINGS_ID, capacity: null },
      data: { capacity: value },
    });
    // Link an UNLINKED legacy row to the default lodge (null-scoped, so a row
    // already linked by migration 20260708000100 is never re-pointed). Only
    // when the default lodge id was resolvable; otherwise the row stays unlinked
    // (documented residual).
    if (defaultLodgeId) {
      await db.lodgeSettings.updateMany({
        where: { id: LODGE_SETTINGS_ID, lodgeId: null },
        data: { lodgeId: defaultLodgeId },
      });
    }
  },
});

/** The effective config Facebook URL, trimmed to null when blank/absent. */
function currentFacebookUrl(): string | null {
  const trimmed = clubConfig.socialLinks?.facebook?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Facebook-URL step (epic #1943, child C5/#1984 — the `facebookUrl` column the
 * 20260717220000_add_club_identity_facebook_url migration added to the SAME
 * ClubIdentitySettings singleton). Backfills the column from the effective
 * `config/club.json socialLinks.facebook` iff the column is still null.
 *
 * ## Why this needs COLUMN-level (not row-level) presence semantics
 * The C1 identity step above is row-level create-if-absent: once the row exists
 * it is never touched. But `facebookUrl` is a NEW column added long after the row
 * (C1 created it with name/shortName/hutLeaderLabel only), so a create-if-absent
 * row-level check would skip every existing install and the column would never
 * backfill. This step therefore keys presence on the COLUMN: `isPresent` is true
 * only when `facebookUrl` is already non-null.
 *
 * ## Why column-level backfill still honours "never overwrite admin intent"
 * The never-overwrite guarantee protects a value an admin deliberately set (or an
 * intentional null they left on a field that EXISTED when they edited). A null
 * `facebookUrl` on a row created before this migration CANNOT be admin intent —
 * the column did not exist when any prior edit was made, so its null is purely
 * "column absent / never populated", exactly the migration-completion case
 * self-heal exists for. The write is additionally guarded so it can only ever
 * fill a null:
 *   - `isPresent` skips the write once the column is non-null (admin-set OR
 *     already-healed), so a configured value is never re-touched;
 *   - the backfill is an atomic `updateMany` scoped to `facebookUrl: null`, so it
 *     cannot clobber a value written between the presence read and the write
 *     (an admin edit or a concurrent booter), and cannot overwrite a non-null;
 *   - it only runs at all when the effective config actually has a Facebook URL,
 *     and only under the run-level primary-config provenance guard.
 * A later intentional admin CLEAR to null is a documented residual: because a
 * null column and a set-from-config column resolve to the identical value today
 * (the resolver falls back to the same `club.json` link), a re-heal is
 * value-preserving at heal time. See the carry-forward note in the PR.
 *
 * ## Order-independence with the identity step
 * The write is a full create-if-absent of the identity row (name/shortName/
 * hutLeaderLabel + facebookUrl) followed by the null-scoped backfill, so the two
 * steps produce the same final row in EITHER execution order: whichever runs
 * first creates the row from the same effective config; the other then no-ops its
 * create (`update: {}`) and, for this step, backfills only its own null column.
 */
export const clubFacebookUrlSelfHealStep = defineSelfHealStep<string | null>({
  name: "club-identity-facebook-url",
  async isPresent(db) {
    // Nothing to backfill when the effective config has no Facebook URL.
    if (currentFacebookUrl() === null) return true;
    const row = await db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { facebookUrl: true },
    });
    return row?.facebookUrl != null;
  },
  currentValue() {
    return currentFacebookUrl();
  },
  async write(db, value) {
    if (value === null) return; // guarded by isPresent; defensive.
    // 1) Ensure the singleton row exists (create-if-absent). Mirrors the identity
    //    step's create-only upsert so this step is order-independent w.r.t. it —
    //    an existing row is left untouched (`update: {}`).
    await db.clubIdentitySettings.upsert({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      create: {
        id: CLUB_IDENTITY_SETTINGS_ID,
        name: clubConfig.name,
        shortName: clubConfig.shortName ?? null,
        hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
        facebookUrl: value,
      },
      update: {},
      select: { id: true },
    });
    // 2) Backfill the column ONLY while it is still null — atomic, so it can
    //    never overwrite an admin-set value or a concurrent booter's write.
    await db.clubIdentitySettings.updateMany({
      where: { id: CLUB_IDENTITY_SETTINGS_ID, facebookUrl: null },
      data: { facebookUrl: value },
    });
  },
});

/**
 * One `AgeTierSetting` row to create when the table is empty. Mirrors the seed's
 * create-if-missing tier rows (`prisma/seed.ts` `seedAgeTierSettings` +
 * `ageTierSetting.upsert`).
 */
interface AgeTierSelfHealRow {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
}

/**
 * Age-tier step (epic #1943, child C4 / issue #1983). Once `age-tier.ts` drops
 * its `config/club.json` fallback and reads age tiers DB-only, a live fork that
 * never re-runs the seed on a `migrate deploy` could otherwise be left with an
 * EMPTY `AgeTierSetting` table and no source of tiers. This step guarantees a
 * primary-config boot populates the table from the effective config tiers so
 * the fork can never end up with zero tiers.
 *
 * Contract differences from the identity singleton step:
 * - **Presence is table-empty, not a fixed id.** The write is skipped whenever
 *   ANY row already exists, so an admin who edited or pruned tiers is never
 *   touched (never-overwrite guarantee at the whole-table grain).
 * - **Atomic multi-row create-if-absent.** When empty, ALL configured tiers are
 *   written in a SINGLE `$transaction` of create-only `upsert({ update: {} })`
 *   calls keyed on the unique `tier`, mirroring the seed rows exactly. The write
 *   is all-or-nothing by necessity: presence is guarded at the whole-table grain
 *   (`findFirst`) but the write spans several rows, so a per-row loop that failed
 *   partway would leave a PARTIAL set (e.g. INFANT+CHILD only) that the next
 *   boot's table-empty check mistakes for "present" and skips forever — wedging
 *   the fork on an incomplete tier table. Wrapping the batch in one transaction
 *   guarantees an interrupted heal rolls back to an EMPTY table so the presence
 *   check retries cleanly next boot (the clean-retry property). Concurrent
 *   blue/green boots that both observe the table empty are safe: the create-only
 *   upsert never overwrites, and a raced INSERT that surfaces as P2002 rolls the
 *   whole transaction back and is caught by the runner as already-present.
 *
 * Scope note: this heals TIERS only. Nightly RATES live independently in
 * `MembershipTypeSeasonRate` (the authoritative runtime rate source, #1930 E4)
 * and are NOT self-healed here — the seed's tier block writes only
 * `AgeTierSetting`, so this mirrors it exactly.
 */
export const ageTierSelfHealStep = defineSelfHealStep<AgeTierSelfHealRow[]>({
  name: "age-tier-settings",
  async isPresent(db) {
    // Table-empty presence: any existing row means the table is populated (an
    // admin edit / prior seed) and MUST NOT be touched.
    const existing = await db.ageTierSetting.findFirst({ select: { tier: true } });
    return existing !== null;
  },
  currentValue() {
    // The EFFECTIVE config tiers (mirrors `seedAgeTierSettings` in
    // prisma/seed.ts). Only reached when provenance === "primary" (the run
    // guard), so `clubConfig` is the fork's real config, never a fallback.
    return clubConfig.ageTiers.map((tier, sortOrder) => ({
      tier: tier.id as AgeTier,
      minAge: tier.minAge,
      maxAge: tier.maxAge,
      label: tier.label,
      subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed:
        tier.familyGroupRequestCreateMemberAllowed,
      sortOrder,
    }));
  },
  async write(db, rows) {
    // ATOMIC multi-row write (see the step docblock's grain note). Presence is
    // guarded at the whole-table grain but the write spans several rows, so the
    // batch MUST be all-or-nothing — a per-row loop failing partway would leave
    // a partial set the next boot mistakes for "present". Each element is the
    // same create-if-absent upsert the seed uses (`prisma/seed.ts`
    // seedAgeTierSettings), keyed on the unique `tier`, so an existing tier is
    // never overwritten. `$transaction` gives all-or-nothing: an interrupted
    // heal rolls back to an empty table (clean retry next boot), and a raced
    // blue/green INSERT that surfaces as P2002 rolls the whole batch back and is
    // caught by the runner as already-present.
    await db.$transaction(
      rows.map((row) =>
        db.ageTierSetting.upsert({
          where: { tier: row.tier },
          create: row,
          update: {},
          select: { tier: true },
        }),
      ),
    );
  },
});

/**
 * The ordered registry of self-heal steps. C3/C4/C5 append their capacity /
 * age-tier / identity steps here (see the module doc). Order is not significant —
 * steps are independent — but keep it stable for predictable logs.
 */
export const SELF_HEAL_STEPS: readonly RegisteredSelfHealStep[] = [
  clubIdentitySelfHealStep,
  clubFacebookUrlSelfHealStep,
  ageTierSelfHealStep,
  lodgeCapacitySelfHealStep,
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type SelfHealOutcome = "healed" | "already-present" | "failed";

export interface SelfHealStepResult {
  name: string;
  outcome: SelfHealOutcome;
  /** Present only when `outcome === "failed"`. */
  error?: string;
}

export interface SelfHealSummary {
  healed: number;
  alreadyPresent: number;
  failed: number;
  /**
   * True when the whole run was skipped because the effective config is a
   * non-`"primary"` fallback (see the fallback guard in the module doc). No DB
   * reads or writes happened; `results` is empty and the counts are all zero.
   */
  skipped: boolean;
  /** The config provenance the run observed — drives the fallback guard. */
  provenance: ClubConfigSource;
  results: SelfHealStepResult[];
}

type SelfHealLogger = Pick<typeof logger, "info" | "warn">;

export interface RunConfigSelfHealOptions {
  /** The Prisma client (or a structural fake in tests). */
  db: SelfHealDb;
  /** Override the registry (tests inject a single step). Defaults to `SELF_HEAL_STEPS`. */
  steps?: readonly RegisteredSelfHealStep[];
  /** Override the logger (tests silence output). Defaults to the app logger. */
  log?: SelfHealLogger;
  /**
   * Effective config provenance. Healing runs ONLY when this is `"primary"`;
   * any fallback (`"example"` / `"safe-default"`) skips the whole run so a bad
   * boot cannot freeze fallback values into the DB. Defaults to the loader's
   * `clubConfigSource` (the eager singleton's provenance). Injected in tests.
   */
  provenance?: ClubConfigSource;
}

/**
 * Run every registered self-heal step once, create-if-absent. NEVER throws: a
 * per-step failure (DB error) is logged and recorded, and the remaining steps
 * still run. A raced concurrent writer (P2002) counts as already-present.
 */
export async function runConfigSelfHeal(
  options: RunConfigSelfHealOptions,
): Promise<SelfHealSummary> {
  const { db } = options;
  const steps = options.steps ?? SELF_HEAL_STEPS;
  const log = options.log ?? logger;
  const provenance = options.provenance ?? clubConfigSource;
  const results: SelfHealStepResult[] = [];

  // Fallback guard: never persist a non-primary config into create-if-absent DB
  // rows. A fallback (example / safe-default) resolves when config/club.json is
  // absent/unreadable/malformed; freezing it would make the placeholder identity
  // (or safe-default capacity + rates) DB-first authoritative and unrecoverable
  // without admin edit / DB surgery. Skipped healing self-repairs on the next
  // boot once a valid primary config is present.
  if (provenance !== "primary") {
    log.warn(
      { scope: "config-self-heal", provenance },
      `Config self-heal skipped: effective config provenance is "${provenance}", ` +
        `not a valid primary config/club.json. Refusing to persist fallback ` +
        `values into create-if-absent DB rows (they would become DB-first ` +
        `authoritative and never be overwritten). Fix config/club.json; healing ` +
        `self-repairs automatically on the next boot once a valid primary config ` +
        `is present.`,
    );
    return {
      healed: 0,
      alreadyPresent: 0,
      failed: 0,
      skipped: true,
      provenance,
      results: [],
    };
  }

  for (const step of steps) {
    try {
      if (await step.isPresent(db)) {
        results.push({ name: step.name, outcome: "already-present" });
        continue;
      }
      try {
        await step.heal(db);
        results.push({ name: step.name, outcome: "healed" });
        log.info(
          { scope: "config-self-heal", step: step.name },
          `Config self-heal populated absent row: ${step.name}`,
        );
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // A concurrent booter (blue/green double-boot) created it first.
          results.push({ name: step.name, outcome: "already-present" });
          continue;
        }
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: step.name, outcome: "failed", error: message });
      log.warn(
        { scope: "config-self-heal", step: step.name, err },
        `Config self-heal step failed (non-fatal): ${step.name}`,
      );
    }
  }

  return {
    healed: results.filter((r) => r.outcome === "healed").length,
    alreadyPresent: results.filter((r) => r.outcome === "already-present").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped: false,
    provenance,
    results,
  };
}
