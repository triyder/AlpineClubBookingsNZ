import { Prisma, type AgeTier, type PrismaClient } from "@prisma/client";
import { clubConfig, clubConfigSource, type ClubConfigSource } from "@/config/club";
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
 *   - `isPresent(db)`  — is the DB row already populated? (guard the write)
 *   - `currentValue()` — the current EFFECTIVE config value to persist
 *   - `write(db, v)`   — a create-if-absent write (upsert with `update:{}`)
 * Keep every write create-if-absent so the never-overwrite guarantee holds.
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
 * - **Per-row create-if-absent.** When empty, each configured tier is written
 *   with `upsert({ update: {} })` keyed on the unique `tier`, mirroring the seed
 *   exactly. Concurrent blue/green boots that both observe the table empty are
 *   safe: the create-only upsert never overwrites, and a raced INSERT that
 *   surfaces as P2002 is caught by the runner as already-present.
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
    // Create-if-absent per row (`update: {}`), keyed on the unique `tier`.
    // Never overwrites an existing tier; a concurrent booter's rows are left
    // as-is. A raced INSERT that surfaces as P2002 propagates to the runner,
    // which treats it as already-present.
    for (const row of rows) {
      await db.ageTierSetting.upsert({
        where: { tier: row.tier },
        create: row,
        update: {},
        select: { tier: true },
      });
    }
  },
});

/**
 * The ordered registry of self-heal steps. C3/C4/C5 append their capacity /
 * age-tier steps here (see the module doc). Order is not significant — steps are
 * independent — but keep it stable for predictable logs.
 */
export const SELF_HEAL_STEPS: readonly RegisteredSelfHealStep[] = [
  clubIdentitySelfHealStep,
  ageTierSelfHealStep,
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
