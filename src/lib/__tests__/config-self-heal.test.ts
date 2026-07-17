import { describe, expect, it, vi } from "vitest";

import { clubConfig } from "@/config/club";
import {
  clubIdentitySelfHealStep,
  defineSelfHealStep,
  isUniqueConstraintError,
  lodgeCapacitySelfHealStep,
  runConfigSelfHeal,
  SELF_HEAL_STEPS,
  type RegisteredSelfHealStep,
  type SelfHealDb,
} from "@/lib/config-self-heal";
import { CLUB_CONFIG_LODGE_CAPACITY } from "@/lib/lodge-capacity";

// Silence the app logger in tests (runConfigSelfHeal logs per step).
const silentLog = { info: vi.fn(), warn: vi.fn() };

/**
 * A stateful in-memory fake of the ClubIdentitySettings singleton delegate.
 * `findUnique` returns the stored row (or null); `upsert` is create-if-absent
 * and throws a P2002 when a row already exists — the exact shape a raced INSERT
 * surfaces under a unique constraint, so the concurrency path is exercised for
 * real rather than mocked away.
 */
function makeIdentityDb(seedRow?: Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", ...seedRow });

  const db = {
    clubIdentitySettings: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.get(where.id) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
        }) => {
          if (rows.has(where.id)) {
            // Row created between our isPresent snapshot and this insert.
            throw Object.assign(
              new Error("Unique constraint failed on the fields: (`id`)"),
              { code: "P2002" },
            );
          }
          rows.set(where.id, { ...create });
          return rows.get(where.id);
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("isUniqueConstraintError", () => {
  it("detects a structural P2002 error", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(
      isUniqueConstraintError(Object.assign(new Error("dup"), { code: "P2002" })),
    ).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
    expect(isUniqueConstraintError({ code: "P2003" })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

describe("runConfigSelfHeal — cold un-backfilled DB", () => {
  it("populates the identity row from the effective config on first run", async () => {
    const { rows, db } = makeIdentityDb();

    const summary = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });

    expect(summary.healed).toBe(1);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-identity-settings",
      outcome: "healed",
    });

    // The row now holds the EFFECTIVE config identity (mirrors the seed upsert).
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
    });
  });

  it("is a no-op on the second run (idempotent)", async () => {
    const { rows, db } = makeIdentityDb();

    await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });
    const upsertCallsAfterFirst = (
      db as unknown as { clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } } }
    ).clubIdentitySettings.upsert.mock.calls.length;

    const second = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });

    expect(second.healed).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(second.failed).toBe(0);
    expect(rows.size).toBe(1);
    // No further write happened on the second run.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.upsert.mock.calls.length,
    ).toBe(upsertCallsAfterFirst);
  });
});

describe("runConfigSelfHeal — never overwrites an admin edit", () => {
  it("leaves an existing admin-configured row untouched", async () => {
    const { rows, db } = makeIdentityDb({
      name: "Admin Renamed Club",
      shortName: "ARC",
      hutLeaderLabel: null, // an intentional null the admin left blank
    });

    const summary = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({
      name: "Admin Renamed Club",
      shortName: "ARC",
      hutLeaderLabel: null,
    });
    // The write path must not be invoked when the row is present.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();
  });
});

describe("runConfigSelfHeal — best-effort resilience", () => {
  it("records a failed step and never throws when the DB errors", async () => {
    const db = {
      clubIdentitySettings: {
        findUnique: vi.fn(async () => {
          throw new Error("connection refused");
        }),
        upsert: vi.fn(),
      },
    } as unknown as SelfHealDb;

    const summary = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });

    expect(summary.failed).toBe(1);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-identity-settings",
      outcome: "failed",
    });
    expect(summary.results[0].error).toContain("connection refused");
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("keeps running later steps after an earlier step fails", async () => {
    const failing: RegisteredSelfHealStep = {
      name: "boom",
      isPresent: vi.fn(async () => {
        throw new Error("boom");
      }),
      heal: vi.fn(),
    };
    const healed = { value: false };
    const ok: RegisteredSelfHealStep = {
      name: "ok",
      isPresent: vi.fn(async () => false),
      heal: vi.fn(async () => {
        healed.value = true;
      }),
    };

    const summary = await runConfigSelfHeal({
      db: {} as SelfHealDb,
      steps: [failing, ok],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.failed).toBe(1);
    expect(summary.healed).toBe(1);
    expect(healed.value).toBe(true);
  });
});

describe("runConfigSelfHeal — blue/green double-boot", () => {
  it("tolerates a concurrent writer (P2002) as already-present with exactly one row", async () => {
    // Both booters share one DB. `findUnique` is pinned to null so BOTH observe
    // an absent row in the racing window; the second `upsert` then hits the
    // unique constraint (P2002) that the fake raises once a row exists.
    const rows = new Map<string, Record<string, unknown>>();
    const db = {
      clubIdentitySettings: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(
          async ({
            where,
            create,
          }: {
            where: { id: string };
            create: Record<string, unknown>;
          }) => {
            if (rows.has(where.id)) {
              throw Object.assign(new Error("Unique constraint failed"), {
                code: "P2002",
              });
            }
            rows.set(where.id, { ...create });
            return rows.get(where.id);
          },
        ),
      },
    } as unknown as SelfHealDb;

    const first = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });
    const second = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary", steps: [clubIdentitySelfHealStep] });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    // Exactly one populated row despite two boots both seeing it absent.
    expect(rows.size).toBe(1);
  });
});

describe("runConfigSelfHeal — config-fallback guard (never freeze a fallback)", () => {
  it("skips ALL healing on a cold DB when provenance is safe-default (zero writes, skip result, warning)", async () => {
    const { rows, db } = makeIdentityDb();
    const log = { info: vi.fn(), warn: vi.fn() };

    const summary = await runConfigSelfHeal({
      db,
      log,
      provenance: "safe-default",
    });

    expect(summary.skipped).toBe(true);
    expect(summary.provenance).toBe("safe-default");
    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([]);

    // Nothing touched the DB at all — not even a presence read.
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { clubIdentitySettings: { findUnique: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      (db as unknown as { clubIdentitySettings: { upsert: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();

    // A loud, greppable warning names the provenance.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      scope: "config-self-heal",
      provenance: "safe-default",
    });
    expect(log.warn.mock.calls[0][1]).toMatch(/self-heal skipped/i);
  });

  it("skips ALL healing when booting on the example config (never persists the example identity)", async () => {
    const { rows, db } = makeIdentityDb();

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "example",
    });

    expect(summary.skipped).toBe(true);
    expect(summary.provenance).toBe("example");
    expect(summary.healed).toBe(0);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { clubIdentitySettings: { upsert: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();
  });

  it("heals on a later boot once config/club.json is fixed (skipped boot leaves the DB cold, next primary boot backfills)", async () => {
    const { rows, db } = makeIdentityDb();

    // Boot 1: a bad/absent primary resolved to safe-default → skipped, DB cold.
    const skippedRun = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "safe-default",
    });
    expect(skippedRun.skipped).toBe(true);
    expect(rows.size).toBe(0);

    // Boot 2: operator fixed config/club.json → provenance "primary" → heals.
    const healedRun = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
    });
    expect(healedRun.skipped).toBe(false);
    expect(healedRun.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
    });
  });
});

/**
 * A stateful in-memory fake of the LodgeSettings delegate the capacity step
 * touches: `findUnique` (COLUMN-level presence probe), `upsert` (create-if-
 * absent, raising P2002 when the row already exists so the concurrency path is
 * exercised for real), and `updateMany` (the atomic `WHERE capacity IS NULL`
 * fill). Rows are keyed by id like the real "default" singleton.
 */
function makeLodgeSettingsDb(seedRow?: { capacity: number | null } & Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", ...seedRow });

  const db = {
    lodgeSettings: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const row = rows.get(where.id);
          if (!row) return null;
          if (select) {
            return Object.fromEntries(
              Object.keys(select).map((k) => [k, row[k] ?? null]),
            );
          }
          return row;
        },
      ),
      // Real Prisma semantics: an existing row runs the (no-op `update: {}`)
      // branch and is left untouched — it does NOT raise P2002. Create-if-absent
      // only.
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
        }) => {
          if (!rows.has(where.id)) {
            rows.set(where.id, { ...create });
          }
          return { id: where.id };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; capacity: null };
          data: { capacity: number };
        }) => {
          const row = rows.get(where.id);
          // Atomic guard: only fill when capacity is still null.
          if (row && where.capacity === null && row.capacity == null) {
            row.capacity = data.capacity;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("lodgeCapacitySelfHealStep — backfills the default lodge capacity (#1982)", () => {
  it("creates the default LodgeSettings row with the config bed total on a cold DB", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({
      id: "default",
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
    });
  });

  it("fills a null capacity on an existing row without touching other columns", async () => {
    const { rows, db } = makeLodgeSettingsDb({
      capacity: null,
      hutLeaderLookaheadDays: 21,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
      hutLeaderLookaheadDays: 21,
    });
    // The row already existed, so no create was attempted destructively.
  });

  it("never overwrites an admin-set capacity", async () => {
    const { rows, db } = makeLodgeSettingsDb({ capacity: 7 });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({ capacity: 7 });
    // Present column → write path (upsert/updateMany) is never invoked.
    expect(
      (db as unknown as { lodgeSettings: { upsert: ReturnType<typeof vi.fn> } })
        .lodgeSettings.upsert,
    ).not.toHaveBeenCalled();
    expect(
      (db as unknown as { lodgeSettings: { updateMany: ReturnType<typeof vi.fn> } })
        .lodgeSettings.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("is idempotent and double-boot safe (second run already-present, one value)", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const first = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });
    const second = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({ capacity: CLUB_CONFIG_LODGE_CAPACITY });
  });

  it("is skipped entirely on a non-primary config (provenance guard, no writes)", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "safe-default",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.skipped).toBe(true);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { lodgeSettings: { findUnique: ReturnType<typeof vi.fn> } })
        .lodgeSettings.findUnique,
    ).not.toHaveBeenCalled();
  });
});

describe("registry", () => {
  it("registers the identity step first, then the lodge-capacity step", () => {
    expect(SELF_HEAL_STEPS[0]).toBe(clubIdentitySelfHealStep);
    expect(SELF_HEAL_STEPS[0].name).toBe("club-identity-settings");
    expect(SELF_HEAL_STEPS).toContain(lodgeCapacitySelfHealStep);
    expect(lodgeCapacitySelfHealStep.name).toBe("lodge-capacity");
  });

  it("defineSelfHealStep binds currentValue + write into heal", async () => {
    const written: string[] = [];
    const step = defineSelfHealStep<string>({
      name: "demo",
      isPresent: async () => false,
      currentValue: () => "value-from-config",
      write: async (_db, value) => {
        written.push(value);
      },
    });

    await step.heal({} as SelfHealDb);

    expect(written).toEqual(["value-from-config"]);
  });
});
