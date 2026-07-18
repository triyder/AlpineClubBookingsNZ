import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
// The bootstrap import waives the pre-apply backup on an empty target; the mock
// proves runDatabaseBackup is never called on that path.
vi.mock("@/lib/backup", () => ({ runDatabaseBackup: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(async () => undefined) }));
// Keep the module's config-provenance import inert and deterministic.
vi.mock("@/config/club", () => ({ clubConfigSource: "safe-default" }));

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup } from "@/lib/backup";
import { buildBundle, sha256Hex } from "@/lib/config-transfer/bundle";
import { applyConfigImport } from "@/lib/config-transfer/apply";
import {
  CONFIG_BOOTSTRAP_ACTOR,
  CONFIG_BOOTSTRAP_AUDIT_ACTION,
  assessBootstrapReadiness,
  runConfigBootstrapImport,
} from "@/lib/config-transfer/bootstrap-import";
import type { ImportPlan } from "@/lib/config-transfer/import-types";

const GENERATED_AT = "2026-07-18T00:00:00.000Z";

function committeeBundle(): Uint8Array {
  return buildBundle({
    entries: [
      {
        path: "committee/roles.csv",
        category: "committee",
        rowCount: 1,
        bytes: strToU8(
          "key,name,description,contactEmail,isActive,sortOrder\npresident,President,,,true,1\n",
        ),
      },
    ],
    appVersion: "0.11.0",
    prismaMigration: null,
    includedCategories: ["committee"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

/**
 * A structural Prisma double. `counts` seed the emptiness probe; the committee
 * delegate + transaction seam let a REAL applyConfigImport run end-to-end and
 * expose whether anything was written.
 */
function harness(
  counts: {
    bootstrapImports?: number;
    interactiveImports?: number;
    bookings?: number;
    nonSystemMembers?: number;
    finishedSetup?: number;
  } = {},
) {
  const create = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const committeeRole = { findMany: vi.fn(async () => []), create, update };

  const auditCount = vi.fn(async (args: { where: { action: string } }) => {
    if (args.where.action === CONFIG_BOOTSTRAP_AUDIT_ACTION) {
      return counts.bootstrapImports ?? 0;
    }
    if (args.where.action === "configuration.imported") {
      return counts.interactiveImports ?? 0;
    }
    return 0;
  });

  const tx = { committeeRole, $executeRaw: vi.fn(async () => 0) };
  const $transaction = vi.fn(
    async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  );

  const db = {
    auditLog: { count: auditCount },
    booking: { count: vi.fn(async () => counts.bookings ?? 0) },
    member: { count: vi.fn(async () => counts.nonSystemMembers ?? 0) },
    setupProgress: { count: vi.fn(async () => counts.finishedSetup ?? 0) },
    committeeRole,
    $transaction,
  } as unknown as PrismaClient;

  return { db, create, update, $transaction };
}

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.mocked(runDatabaseBackup).mockReset();
  vi.mocked(createAuditLog).mockClear();
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
});

describe("assessBootstrapReadiness — empty-target definition", () => {
  it("applies when the target is pristine post-seed (all footprint signals zero)", async () => {
    const { db } = harness();
    await expect(assessBootstrapReadiness(db)).resolves.toEqual({
      decision: "apply",
    });
  });

  it("refuses calmly (info) when a prior bootstrap import already ran — steady state", async () => {
    const { db } = harness({ bootstrapImports: 1 });
    const readiness = await assessBootstrapReadiness(db);
    expect(readiness).toMatchObject({ decision: "refuse", severity: "info" });
  });

  it("refuses (warn) when a config bundle was already imported interactively", async () => {
    const { db } = harness({ interactiveImports: 1 });
    expect(await assessBootstrapReadiness(db)).toMatchObject({
      decision: "refuse",
      severity: "warn",
    });
  });

  it.each([
    ["a booking exists", { bookings: 1 }],
    ["a non-system member exists", { nonSystemMembers: 1 }],
    ["the setup wizard was finished", { finishedSetup: 1 }],
  ])("refuses (warn) when %s", async (_label, counts) => {
    const { db } = harness(counts);
    expect(await assessBootstrapReadiness(db)).toMatchObject({
      decision: "refuse",
      severity: "warn",
    });
  });

  it("does not consult config-singleton rows (self-heal interaction)", async () => {
    // The probe touches only auditLog/booking/member/setupProgress — never the
    // club identity / age-tier / theme singletons the C2 self-heal populates.
    // So a self-healed row can never make an empty target look configured.
    const { db } = harness();
    const dbAny = db as unknown as Record<string, unknown>;
    expect(dbAny.clubIdentitySettings).toBeUndefined();
    expect(dbAny.ageTierSetting).toBeUndefined();
    await expect(assessBootstrapReadiness(db)).resolves.toEqual({
      decision: "apply",
    });
  });
});

describe("runConfigBootstrapImport — fresh empty target", () => {
  it("applies the bundle through the real pipeline and writes the audit marker, without a backup", async () => {
    const { db, create } = harness();
    const bytes = committeeBundle();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => bytes,
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("applied");
    expect(result.bundleSha256).toBe(sha256Hex(bytes));
    // The committee role was created (a real apply ran).
    expect(create).toHaveBeenCalledTimes(1);
    // No backup on an empty target.
    expect(runDatabaseBackup).not.toHaveBeenCalled();

    // Two audit rows: the pipeline's configuration.imported + the bootstrap
    // marker. Assert the bootstrap marker's shape (system actor, checksum).
    const actions = vi
      .mocked(createAuditLog)
      .mock.calls.map((c) => c[0].action);
    expect(actions).toContain("configuration.imported");
    expect(actions).toContain(CONFIG_BOOTSTRAP_AUDIT_ACTION);

    const marker = vi
      .mocked(createAuditLog)
      .mock.calls.find((c) => c[0].action === CONFIG_BOOTSTRAP_AUDIT_ACTION)![0];
    expect(marker.memberId).toBe(CONFIG_BOOTSTRAP_ACTOR);
    expect(marker.outcome).toBe("success");
    expect((marker.metadata as Record<string, unknown>).bundleSha256).toBe(
      sha256Hex(bytes),
    );
  });
});

describe("runConfigBootstrapImport — fail-closed refusals", () => {
  it("refuses a non-empty target (steady state) without planning or applying", async () => {
    const { db, create } = harness({ bootstrapImports: 1 });
    const applyImpl = vi.fn();
    const planImpl = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => committeeBundle(),
      planImpl: planImpl as never,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-configured");
    expect(planImpl).not.toHaveBeenCalled();
    expect(applyImpl).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // A steady-state refusal is logged calmly, not as an error/warning.
    expect(silentLog.info).toHaveBeenCalled();
    expect(silentLog.warn).not.toHaveBeenCalled();
    expect(silentLog.error).not.toHaveBeenCalled();
  });

  it("refuses a non-empty target (partial config: a booking exists) with a warning", async () => {
    const { db } = harness({ bookings: 3 });
    const applyImpl = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => committeeBundle(),
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-configured");
    expect(applyImpl).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("refuses (refused-invalid) a bundle whose plan has validation errors — no apply", async () => {
    const { db } = harness();
    const applyImpl = vi.fn();
    const planImpl = vi.fn(async () => ({
      errors: ["committee/roles.csv row 1: sortOrder — must be an integer"],
      categories: [],
      selectedCategories: ["committee"],
    })) as unknown as never;

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => committeeBundle(),
      planImpl,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it("aborts (refused-invalid) when a plan step would need an interactive rename decision", async () => {
    const { db } = harness();
    const applyImpl = vi.fn();
    const plan = {
      errors: [],
      selectedCategories: ["committee"],
      categories: [
        {
          category: "committee",
          items: [
            {
              entity: "committee-role",
              key: "president",
              action: "create",
              candidates: [{ id: "role-1", label: "Chairperson" }],
            },
          ],
        },
      ],
    } as unknown as ImportPlan;
    const planImpl = vi.fn(async () => plan) as unknown as never;

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => committeeBundle(),
      planImpl,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-zip) bundle atomically — nothing written", async () => {
    const { db, create } = harness();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => strToU8("this is not a zip"),
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("failed");
    expect(create).not.toHaveBeenCalled();
    expect(runDatabaseBackup).not.toHaveBeenCalled();
  });
});

describe("runConfigBootstrapImport — I/O + resilience", () => {
  it("is a silent no-op when CONFIG_BUNDLE_IMPORT_PATH is unset", async () => {
    const { db } = harness();
    const readBundleFile = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: undefined,
      log: silentLog,
      readBundleFile,
    });

    expect(result.outcome).toBe("disabled");
    expect(readBundleFile).not.toHaveBeenCalled();
  });

  it("continues boot (unreadable) when the file cannot be read", async () => {
    const { db } = harness();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/missing.zip",
      log: silentLog,
      readBundleFile: async () => {
        throw new Error("ENOENT: no such file");
      },
    });

    expect(result.outcome).toBe("unreadable");
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("never throws — an apply that throws is caught and reported as failed", async () => {
    const { db, create } = harness();
    const applyImpl = vi.fn(async () => {
      throw new Error("boom in apply");
    });

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      readBundleFile: async () => committeeBundle(),
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("failed");
    expect(create).not.toHaveBeenCalled();
    expect(silentLog.error).toHaveBeenCalled();
  });
});
