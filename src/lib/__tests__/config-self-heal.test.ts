import { describe, expect, it, vi } from "vitest";

import { clubConfig } from "@/config/club";
import {
  clubFacebookUrlSelfHealStep,
  clubIdentitySelfHealStep,
  defineSelfHealStep,
  isUniqueConstraintError,
  runConfigSelfHeal,
  SELF_HEAL_STEPS,
  type RegisteredSelfHealStep,
  type SelfHealDb,
} from "@/lib/config-self-heal";

// The effective config Facebook link (the test config, club.example.json, sets
// one). The facebookUrl self-heal step backfills this into the null column.
const CONFIG_FACEBOOK_URL = clubConfig.socialLinks?.facebook ?? null;

// Silence the app logger in tests (runConfigSelfHeal logs per step).
const silentLog = { info: vi.fn(), warn: vi.fn() };

/**
 * A stateful in-memory fake of the ClubIdentitySettings singleton delegate.
 * `findUnique` returns the stored row (or null); `upsert` is real create-or-
 * update (create when absent, else merge the `update` object — which is `{}` for
 * every create-if-absent step, so an existing row is left untouched);
 * `updateMany` merges `data` only when the row matches every column predicate in
 * `where` (used by the facebookUrl step's null-scoped, non-overwriting backfill).
 * The raced-INSERT (P2002) path is exercised for real by the dedicated
 * double-boot test below, which pins its own fake.
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
          update,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
          update?: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.id);
          if (existing) {
            const merged = { ...existing, ...(update ?? {}) };
            rows.set(where.id, merged);
            return merged;
          }
          rows.set(where.id, { ...create });
          return rows.get(where.id);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown> & { id: string };
          data: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.id);
          if (!existing) return { count: 0 };
          for (const [key, value] of Object.entries(where)) {
            if (key === "id") continue;
            const current = existing[key] ?? null;
            if (current !== value) return { count: 0 };
          }
          rows.set(where.id, { ...existing, ...data });
          return { count: 1 };
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

    const summary = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });

    // Both identity fields AND the facebookUrl column heal on a cold DB.
    expect(summary.healed).toBe(2);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-identity-settings",
      outcome: "healed",
    });
    expect(summary.results[1]).toMatchObject({
      name: "club-identity-facebook-url",
      outcome: "healed",
    });

    // The row now holds the EFFECTIVE config identity (mirrors the seed upsert).
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    });
  });

  it("is a no-op on the second run (idempotent)", async () => {
    const { rows, db } = makeIdentityDb();

    await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });
    const upsertCallsAfterFirst = (
      db as unknown as { clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } } }
    ).clubIdentitySettings.upsert.mock.calls.length;

    const second = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });

    expect(second.healed).toBe(0);
    // Both steps now see a populated row/column and skip.
    expect(second.alreadyPresent).toBe(2);
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
      facebookUrl: "https://facebook.com/admin-set", // admin-configured link
    });

    const summary = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });

    expect(summary.healed).toBe(0);
    // Both steps see a populated row/column and skip.
    expect(summary.alreadyPresent).toBe(2);
    expect(rows.get("default")).toMatchObject({
      name: "Admin Renamed Club",
      shortName: "ARC",
      hutLeaderLabel: null,
      facebookUrl: "https://facebook.com/admin-set",
    });
    // The write path must not be invoked when the row is present.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();
    // Nor the facebookUrl backfill.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { updateMany: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.updateMany,
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

    // Scope to the identity step so the assertion targets exactly one failure.
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

    const first = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });
    const second = await runConfigSelfHeal({ db, log: silentLog, provenance: "primary" });

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
    expect(healedRun.healed).toBe(2);
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    });
  });
});

describe("registry", () => {
  it("registers the identity step first and the facebookUrl step alongside it", () => {
    expect(SELF_HEAL_STEPS[0]).toBe(clubIdentitySelfHealStep);
    expect(SELF_HEAL_STEPS[0].name).toBe("club-identity-settings");
    expect(SELF_HEAL_STEPS).toContain(clubFacebookUrlSelfHealStep);
    expect(clubFacebookUrlSelfHealStep.name).toBe("club-identity-facebook-url");
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

describe("facebookUrl self-heal step (C5 #1984)", () => {
  it("backfills the null column on a row the identity step already created (migration completion)", async () => {
    // The C1 identity step created this row BEFORE the facebookUrl column existed,
    // so its null facebookUrl is 'column never populated', not admin intent.
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      shortName: "EC",
      hutLeaderLabel: "Warden",
      // no facebookUrl column value (predates the migration)
    });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      name: "Existing Club", // identity fields untouched
      facebookUrl: CONFIG_FACEBOOK_URL, // column backfilled from config
    });
  });

  it("never overwrites an admin-set facebookUrl", async () => {
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      facebookUrl: "https://facebook.com/admin-choice",
    });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({
      facebookUrl: "https://facebook.com/admin-choice",
    });
    // Neither the create-if-absent upsert nor the null-scoped backfill fired.
    expect(
      (db as unknown as { clubIdentitySettings: { updateMany: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("produces the same final row regardless of step order (order-independent)", async () => {
    const forward = makeIdentityDb();
    await runConfigSelfHeal({
      db: forward.db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    const reversed = makeIdentityDb();
    await runConfigSelfHeal({
      db: reversed.db,
      steps: [clubFacebookUrlSelfHealStep, clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    const expected = {
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    };
    expect(forward.rows.get("default")).toMatchObject(expected);
    expect(reversed.rows.get("default")).toMatchObject(expected);
  });

  it("does not clobber a facebookUrl written between its presence read and its backfill (mid-race)", async () => {
    // The row exists with a NULL column, so isPresent proceeds to write. A
    // concurrent admin edit / booter then sets the column in the window AFTER the
    // presence read but BEFORE the null-scoped backfill — modelled by mutating the
    // row inside the create-if-absent upsert, which runs first in the step's write
    // (immediately before updateMany). The atomic `where: { facebookUrl: null }`
    // predicate must then match nothing, so the raced value survives.
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      facebookUrl: null,
    });
    const RACED_VALUE = "https://facebook.com/won-the-race";
    const settings = db as unknown as {
      clubIdentitySettings: {
        upsert: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
      };
    };
    const originalUpsert =
      settings.clubIdentitySettings.upsert.getMockImplementation()! as (
        args: unknown,
      ) => Promise<unknown>;
    settings.clubIdentitySettings.upsert.mockImplementation(
      async (args: unknown) => {
        // A concurrent writer lands the admin value inside the race window.
        rows.set("default", { ...rows.get("default"), facebookUrl: RACED_VALUE });
        return originalUpsert(args);
      },
    );

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    // The step believed it wrote (its presence read saw null), but the null-scoped
    // backfill matched no row (count: 0), so the raced value is NOT overwritten.
    expect(summary.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({ facebookUrl: RACED_VALUE });
    await expect(
      settings.clubIdentitySettings.updateMany.mock.results[0]?.value,
    ).resolves.toMatchObject({ count: 0 });
  });

  it("no-ops (present, zero writes) when the effective config has no facebook link", async () => {
    // The step must be inert when config/club.json carries no socialLinks.facebook
    // — there is nothing to backfill. Drive it against a fresh module instance whose
    // clubConfig has an empty socialLinks (the shared test config DOES set a link).
    vi.resetModules();
    vi.doMock("@/config/club", () => ({
      clubConfig: {
        name: "No Social Club",
        shortName: null,
        hutLeaderLabel: null,
        socialLinks: {},
      },
      clubConfigSource: "primary",
    }));
    try {
      const { clubFacebookUrlSelfHealStep: step, runConfigSelfHeal: run } =
        await import("@/lib/config-self-heal");
      const { rows, db } = makeIdentityDb(); // cold DB

      const summary = await run({
        db,
        steps: [step],
        log: silentLog,
        provenance: "primary",
      });

      // Present/no-op: isPresent short-circuits on the null config value before any
      // DB access, so nothing is read or written.
      expect(summary.healed).toBe(0);
      expect(summary.alreadyPresent).toBe(1);
      expect(rows.size).toBe(0);
      const settings = db as unknown as {
        clubIdentitySettings: {
          findUnique: ReturnType<typeof vi.fn>;
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      };
      expect(settings.clubIdentitySettings.findUnique).not.toHaveBeenCalled();
      expect(settings.clubIdentitySettings.upsert).not.toHaveBeenCalled();
      expect(settings.clubIdentitySettings.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/config/club");
      vi.resetModules();
    }
  });
});
