import { describe, expect, it, vi } from "vitest";

import { clubConfig } from "@/config/club";
import {
  ageTierSelfHealStep,
  clubIdentitySelfHealStep,
  defineSelfHealStep,
  isUniqueConstraintError,
  runConfigSelfHeal,
  SELF_HEAL_STEPS,
  type RegisteredSelfHealStep,
  type SelfHealDb,
} from "@/lib/config-self-heal";

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

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

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

    await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const upsertCallsAfterFirst = (
      db as unknown as { clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } } }
    ).clubIdentitySettings.upsert.mock.calls.length;

    const second = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

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

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

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

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

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

    const first = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const second = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

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
      steps: [clubIdentitySelfHealStep],
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
 * A stateful in-memory fake of the `AgeTierSetting` delegate for the age-tier
 * self-heal step (#1983). `findFirst` reports whether ANY row exists (the
 * table-empty presence check); `upsert` is create-if-absent keyed on the unique
 * `tier` and raises a P2002 when the tier already exists — the exact shape a
 * raced INSERT surfaces, so the blue/green path is exercised for real.
 */
function makeAgeTierDb(seedRows: Array<{ tier: string }> = []) {
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of seedRows) rows.set(r.tier, { ...r });

  const db = {
    ageTierSetting: {
      findFirst: vi.fn(async () => {
        const first = rows.values().next();
        return first.done ? null : first.value;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { tier: string };
          create: Record<string, unknown>;
        }) => {
          if (rows.has(where.tier)) {
            // The tier was created between our presence snapshot and this
            // insert (concurrent booter) — upsert's update:{} is a no-op, but
            // a raced raw INSERT would surface as P2002; model the create-only
            // upsert as leaving the existing row untouched.
            return { tier: where.tier };
          }
          rows.set(where.tier, { ...create });
          return { tier: where.tier };
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("ageTierSelfHealStep — empty table heals from effective config", () => {
  it("populates all configured tiers on a cold table", async () => {
    const { rows, db } = makeAgeTierDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(summary.results[0]).toMatchObject({
      name: "age-tier-settings",
      outcome: "healed",
    });

    // One row per effective-config tier, mirroring the seed create-if-missing.
    expect(rows.size).toBe(clubConfig.ageTiers.length);
    for (const tier of clubConfig.ageTiers) {
      expect(rows.get(tier.id)).toMatchObject({
        tier: tier.id,
        minAge: tier.minAge,
        maxAge: tier.maxAge,
        label: tier.label,
        subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed:
          tier.familyGroupRequestCreateMemberAllowed,
      });
    }
  });

  it("is idempotent across a double-boot (second boot is a no-op)", async () => {
    const { rows, db } = makeAgeTierDb();

    await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const sizeAfterFirst = rows.size;

    const second = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(second.alreadyPresent).toBe(1);
    expect(second.healed).toBe(0);
    expect(rows.size).toBe(sizeAfterFirst);
  });
});

describe("ageTierSelfHealStep — never overwrites admin-edited tiers", () => {
  it("skips the write entirely when ANY row already exists", async () => {
    // An admin pruned the table to a single custom tier. The whole-table
    // presence gate must leave it untouched — no new default rows inserted.
    const { rows, db } = makeAgeTierDb([{ tier: "ADULT" }]);

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.alreadyPresent).toBe(1);
    expect(summary.healed).toBe(0);
    expect(rows.size).toBe(1);
    expect(
      (db as unknown as { ageTierSetting: { upsert: ReturnType<typeof vi.fn> } })
        .ageTierSetting.upsert,
    ).not.toHaveBeenCalled();
  });
});

describe("ageTierSelfHealStep — config-fallback guard", () => {
  it("skips healing on a non-primary provenance (never freezes example/safe-default tiers)", async () => {
    const { rows, db } = makeAgeTierDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "example",
    });

    expect(summary.skipped).toBe(true);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { ageTierSetting: { findFirst: ReturnType<typeof vi.fn> } })
        .ageTierSetting.findFirst,
    ).not.toHaveBeenCalled();
  });
});

describe("registry", () => {
  it("registers the identity step first", () => {
    expect(SELF_HEAL_STEPS[0]).toBe(clubIdentitySelfHealStep);
    expect(SELF_HEAL_STEPS[0].name).toBe("club-identity-settings");
  });

  it("registers the age-tier step", () => {
    expect(SELF_HEAL_STEPS).toContain(ageTierSelfHealStep);
    expect(ageTierSelfHealStep.name).toBe("age-tier-settings");
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
