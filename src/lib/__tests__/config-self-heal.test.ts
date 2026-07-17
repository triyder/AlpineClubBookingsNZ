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
 * self-heal step (#1983), modelling the ATOMIC multi-row write for real.
 *
 * - `findFirst` reports whether ANY row exists (the table-empty presence
 *   check). `pinPresenceAbsent` forces it to report empty even once rows exist,
 *   so both racers in a blue/green double-boot observe the empty window.
 * - `upsert` returns a LAZY operation (mirroring Prisma's un-executed
 *   `PrismaPromise`): it is NOT applied until the enclosing `$transaction` runs
 *   it. When run it is create-if-absent keyed on the unique `tier`; if the tier
 *   already exists it throws a real P2002-shaped error — the exact shape a raced
 *   INSERT surfaces under the unique constraint (concurrent blue/green boot).
 * - `$transaction([...])` runs the queued ops in order and is ALL-OR-NOTHING:
 *   any thrown error (an injected transient failure via `fail.tier`, or a raced
 *   P2002) restores every row to the pre-transaction snapshot and rethrows — so
 *   the production step's atomicity + clean-retry guarantee is exercised for
 *   real rather than asserted by fiat.
 *
 * `fail.tier` injects a mid-write transient (non-P2002) failure: the op for that
 * tier throws, modelling a DB blip partway through the batch. Set it back to
 * null to let a later run succeed (the clean-retry pin).
 */
function makeAgeTierDb(
  seedRows: Array<{ tier: string }> = [],
  options: { pinPresenceAbsent?: boolean } = {},
) {
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of seedRows) rows.set(r.tier, { ...r });
  const fail: { tier: string | null } = { tier: null };

  const db = {
    ageTierSetting: {
      findFirst: vi.fn(async () => {
        if (options.pinPresenceAbsent) return null;
        const first = rows.values().next();
        return first.done ? null : first.value;
      }),
      upsert: vi.fn(
        ({
          where,
          create,
        }: {
          where: { tier: string };
          create: Record<string, unknown>;
        }) => ({
          // Lazy op — applied only when `$transaction` runs it, exactly as a
          // Prisma `PrismaPromise` is deferred until the transaction executes.
          __run: () => {
            if (fail.tier === where.tier) {
              throw new Error(`transient DB error writing tier ${where.tier}`);
            }
            if (rows.has(where.tier)) {
              // The tier was created between our table-empty snapshot and this
              // insert (concurrent booter) — a raced INSERT under unique(tier)
              // surfaces as P2002.
              throw Object.assign(
                new Error("Unique constraint failed on the fields: (`tier`)"),
                { code: "P2002" },
              );
            }
            rows.set(where.tier, { ...create });
            return { tier: where.tier };
          },
        }),
      ),
    },
    $transaction: vi.fn(async (ops: Array<{ __run: () => unknown }>) => {
      // Snapshot the table, then apply the queued ops. Any failure rolls the
      // WHOLE batch back to the snapshot (atomic all-or-nothing) and rethrows.
      const snapshot = new Map(
        [...rows].map(([k, v]) => [k, { ...v }] as const),
      );
      const results: unknown[] = [];
      try {
        for (const op of ops) results.push(op.__run());
        return results;
      } catch (err) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        throw err;
      }
    }),
  };

  return { rows, fail, db: db as unknown as SelfHealDb };
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

describe("ageTierSelfHealStep — blue/green double-boot race (atomic write)", () => {
  it("two boots both seeing the table empty yield exactly one full 4-row set; the second is already-present", async () => {
    // Both booters share one table and observe it empty in the racing window
    // (pinPresenceAbsent forces `findFirst` to report empty for both). The first
    // transaction inserts the full set; the second transaction's first upsert
    // then collides on unique(tier) → P2002 → the whole batch rolls back → the
    // runner records already-present. Never a partial or duplicated set.
    const { rows, db } = makeAgeTierDb([], { pinPresenceAbsent: true });

    const first = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const second = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    // Exactly one full set despite both boots seeing the table empty.
    expect(rows.size).toBe(clubConfig.ageTiers.length);
  });
});

describe("ageTierSelfHealStep — mid-write transient failure (clean retry)", () => {
  it("a failure partway through leaves the table EMPTY (atomic rollback), and the next boot heals every tier", async () => {
    const { rows, fail, db } = makeAgeTierDb();
    // Fail on the third-written tier: under a non-atomic per-row loop this would
    // leave a partial set (the first two tiers) that wedges the table forever.
    const midTier = clubConfig.ageTiers[2].id;
    fail.tier = midTier;

    const failed = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(failed.failed).toBe(1);
    expect(failed.results[0]).toMatchObject({
      name: "age-tier-settings",
      outcome: "failed",
    });
    // Atomic rollback: NO partial set. The table is left completely empty so the
    // table-empty presence check retries cleanly on the next boot.
    expect(rows.size).toBe(0);

    // Next boot with the transient blip cleared heals the full set.
    fail.tier = null;
    const healed = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(healed.healed).toBe(1);
    expect(healed.results[0].outcome).toBe("healed");
    expect(rows.size).toBe(clubConfig.ageTiers.length);
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
