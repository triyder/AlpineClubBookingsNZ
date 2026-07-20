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
import {
  MAX_BUNDLE_BYTES,
  buildBundle,
  sha256Hex,
} from "@/lib/config-transfer/bundle";
import { applyConfigImport } from "@/lib/config-transfer/apply";
import { buildImportPlan } from "@/lib/config-transfer/import";
import {
  CONFIG_BOOTSTRAP_ACTOR,
  CONFIG_BOOTSTRAP_AUDIT_ACTION,
  SYSTEM_AUDIT_ACTOR_PREFIX,
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

/** An induction bundle whose single template key is `${name}/${version}`. */
function inductionBundle(name: string, version: string): Uint8Array {
  const doc = [
    {
      name,
      version,
      kind: "NEW_MEMBER",
      sourceLabel: null,
      isActive: true,
      sections: [],
    },
  ];
  return buildBundle({
    entries: [
      {
        path: "induction/templates.json",
        category: "induction",
        rowCount: 1,
        bytes: strToU8(JSON.stringify(doc)),
      },
    ],
    appVersion: "0.11.0",
    prismaMigration: null,
    includedCategories: ["induction"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

interface HarnessCounts {
  bootstrapImports?: number;
  interactiveImports?: number;
  bookings?: number;
  nonSystemMembers?: number;
  finishedSetup?: number;
  /** Signal 5: SetupProgress rows with completed or skipped step ids. */
  wizardTouched?: number;
  /** Signal 6: audit rows with a member (non-`system:`) actor. */
  memberActorAudits?: number;
}

/**
 * A structural Prisma double. `state` seeds the SIX emptiness-probe signals
 * (mutable, so a test can flip a signal mid-run to simulate a concurrent
 * writer); the committee/induction delegates + transaction seam let a REAL
 * applyConfigImport run end-to-end — including the in-lock re-check, which
 * probes the SAME state through the tx client — and expose whether anything
 * was written.
 */
function harness(
  counts: HarnessCounts = {},
  options: {
    inductionTemplates?: Array<{
      id: string;
      name: string;
      version: string;
      kind: string;
      sourceLabel: string | null;
      isActive: boolean;
      sections: unknown[];
    }>;
  } = {},
) {
  const state: Required<HarnessCounts> = {
    bootstrapImports: counts.bootstrapImports ?? 0,
    interactiveImports: counts.interactiveImports ?? 0,
    bookings: counts.bookings ?? 0,
    nonSystemMembers: counts.nonSystemMembers ?? 0,
    finishedSetup: counts.finishedSetup ?? 0,
    wizardTouched: counts.wizardTouched ?? 0,
    memberActorAudits: counts.memberActorAudits ?? 0,
  };

  const create = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const committeeRole = { findMany: vi.fn(async () => []), create, update };
  const inductionChecklistTemplate = {
    findMany: vi.fn(async () => options.inductionTemplates ?? []),
  };

  const auditCount = vi.fn(
    async (args: { where: { action?: string; OR?: unknown } }) => {
      if (args.where.action === CONFIG_BOOTSTRAP_AUDIT_ACTION) {
        return state.bootstrapImports;
      }
      if (args.where.action === "configuration.imported") {
        return state.interactiveImports;
      }
      // The member-actor footprint query (signal 6) has no action filter.
      if (!args.where.action) return state.memberActorAudits;
      return 0;
    },
  );
  const setupProgressCount = vi.fn(
    async (args: { where: { completedAt?: unknown } }) =>
      args.where.completedAt ? state.finishedSetup : state.wizardTouched,
  );

  const probeDelegates = {
    auditLog: { count: auditCount },
    booking: { count: vi.fn(async () => state.bookings) },
    member: { count: vi.fn(async () => state.nonSystemMembers) },
    setupProgress: { count: setupProgressCount },
  };

  // The tx client shares the probe delegates so the in-lock re-check sees the
  // same (possibly mutated) state as the boot probe.
  const tx = {
    ...probeDelegates,
    committeeRole,
    inductionChecklistTemplate,
    $executeRaw: vi.fn(async () => 0),
  };
  const $transaction = vi.fn(
    async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  );

  const db = {
    ...probeDelegates,
    committeeRole,
    inductionChecklistTemplate,
    $transaction,
  } as unknown as PrismaClient;

  return { db, tx, state, create, update, $transaction, auditCount };
}

/** File seams for tests: an in-cap regular file whose bytes are `bytes()`. */
function fileSeams(bytes: () => Uint8Array) {
  return {
    statBundleFile: vi.fn(async () => ({ size: 1024, isFile: true })),
    readBundleFile: vi.fn(async () => bytes()),
  };
}

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.mocked(runDatabaseBackup).mockReset();
  vi.mocked(createAuditLog).mockClear();
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
});

describe("assessBootstrapReadiness — six-signal empty-target definition", () => {
  it("applies when the target is pristine post-seed (all six footprint signals absent), minting the branded proof", async () => {
    const { db } = harness();
    const readiness = await assessBootstrapReadiness(db);
    expect(readiness.decision).toBe("apply");
    if (readiness.decision !== "apply") throw new Error("unreachable");
    // The proof is the type-level key to applyConfigImport's backup waiver.
    expect(readiness.proof).toBeDefined();
    expect(readiness.proof.assessedAt).toBeInstanceOf(Date);
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
    // Signal 5: any wizard interaction, even without the explicit finish
    // action that sets completedAt (a /admin/setup-configured club).
    ["the setup wizard has completed/skipped steps", { wizardTouched: 1 }],
    // Signal 6: any audit row with a member actor (direct-admin-editor
    // configuration audits with the admin's member id).
    ["an audit row has a member actor", { memberActorAudits: 1 }],
  ])("refuses (warn) when %s", async (_label, counts) => {
    const { db } = harness(counts);
    expect(await assessBootstrapReadiness(db)).toMatchObject({
      decision: "refuse",
      severity: "warn",
    });
  });

  it("excludes system: actors and actor-less rows from the member-actor probe (signal 6)", async () => {
    const { db, auditCount } = harness();
    await assessBootstrapReadiness(db);
    const footprintCall = auditCount.mock.calls
      .map((c) => c[0])
      .find((args) => !args.where.action);
    // Both actor columns must be non-null AND not `system:`-prefixed to count
    // as operator footprint — the seed writes no audit rows at all, system
    // actors (this feature) are synthetic, and cron rows have null actors.
    expect(footprintCall).toEqual({
      where: {
        OR: [
          {
            AND: [
              { memberId: { not: null } },
              {
                NOT: {
                  memberId: { startsWith: SYSTEM_AUDIT_ACTOR_PREFIX },
                },
              },
            ],
          },
          {
            AND: [
              { actorMemberId: { not: null } },
              {
                NOT: {
                  actorMemberId: { startsWith: SYSTEM_AUDIT_ACTOR_PREFIX },
                },
              },
            ],
          },
        ],
      },
    });
    expect(CONFIG_BOOTSTRAP_ACTOR.startsWith(SYSTEM_AUDIT_ACTOR_PREFIX)).toBe(
      true,
    );
  });

  it("does not consult config-singleton rows (self-heal interaction)", async () => {
    // The probe touches only auditLog/booking/member/setupProgress — never the
    // club identity / age-tier / theme singletons the C2 self-heal populates.
    // So a self-healed row can never make an empty target look configured.
    const { db } = harness();
    const dbAny = db as unknown as Record<string, unknown>;
    expect(dbAny.clubIdentitySettings).toBeUndefined();
    expect(dbAny.ageTierSetting).toBeUndefined();
    await expect(assessBootstrapReadiness(db)).resolves.toMatchObject({
      decision: "apply",
    });
  });
});

describe("runConfigBootstrapImport — fresh empty target", () => {
  it("applies the bundle through the real pipeline, re-checks in-lock, and writes the marker inside the transaction, without a backup", async () => {
    const h = harness();
    const bytes = committeeBundle();

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => bytes),
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("applied");
    expect(result.bundleSha256).toBe(sha256Hex(bytes));
    // The committee role was created (a real apply ran).
    expect(h.create).toHaveBeenCalledTimes(1);
    // No backup on an empty target.
    expect(runDatabaseBackup).not.toHaveBeenCalled();

    // The emptiness probe ran twice: at boot AND again inside the advisory
    // lock (S4/R1 TOCTOU guard) — both saw the bootstrap-marker count query.
    const markerProbes = h.auditCount.mock.calls.filter(
      (c) => c[0].where.action === CONFIG_BOOTSTRAP_AUDIT_ACTION,
    );
    expect(markerProbes.length).toBe(2);

    // Two audit rows: the pipeline's configuration.imported + the bootstrap
    // marker. Assert the bootstrap marker's shape (system actor, checksum)
    // AND that it was written on the TRANSACTION client — marker and config
    // writes commit atomically.
    const actions = vi
      .mocked(createAuditLog)
      .mock.calls.map((c) => c[0].action);
    expect(actions).toContain("configuration.imported");
    expect(actions).toContain(CONFIG_BOOTSTRAP_AUDIT_ACTION);

    const markerCall = vi
      .mocked(createAuditLog)
      .mock.calls.find((c) => c[0].action === CONFIG_BOOTSTRAP_AUDIT_ACTION)!;
    const marker = markerCall[0];
    expect(marker.memberId).toBe(CONFIG_BOOTSTRAP_ACTOR);
    expect(marker.outcome).toBe("success");
    expect((marker.metadata as Record<string, unknown>).bundleSha256).toBe(
      sha256Hex(bytes),
    );
    expect(markerCall[1]).toBe(h.tx);
  });
});

describe("runConfigBootstrapImport — fail-closed refusals", () => {
  it("refuses a non-empty target (steady state) without any file I/O, planning, or applying", async () => {
    const h = harness({ bootstrapImports: 1 });
    const applyImpl = vi.fn();
    const planImpl = vi.fn();
    const seams = fileSeams(() => committeeBundle());

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...seams,
      planImpl: planImpl as never,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-configured");
    // S3: the probe runs FIRST — a configured steady-state boot never touches
    // the bundle file at all.
    expect(seams.statBundleFile).not.toHaveBeenCalled();
    expect(seams.readBundleFile).not.toHaveBeenCalled();
    expect(planImpl).not.toHaveBeenCalled();
    expect(applyImpl).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    // A steady-state refusal is logged calmly, not as an error/warning.
    expect(silentLog.info).toHaveBeenCalled();
    expect(silentLog.warn).not.toHaveBeenCalled();
    expect(silentLog.error).not.toHaveBeenCalled();
  });

  it("refuses a non-empty target (partial config: a booking exists) with a warning", async () => {
    const h = harness({ bookings: 3 });
    const applyImpl = vi.fn();

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => committeeBundle()),
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-configured");
    expect(applyImpl).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("refuses (refused-invalid) a bundle whose plan has validation errors — no apply", async () => {
    const h = harness();
    const applyImpl = vi.fn();
    const planImpl = vi.fn(async () => ({
      errors: ["committee/roles.csv row 1: sortOrder — must be an integer"],
      categories: [],
      selectedCategories: ["committee"],
    })) as unknown as never;

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => committeeBundle()),
      planImpl,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(applyImpl).not.toHaveBeenCalled();
  });

  it("aborts (refused-invalid) when a plan step would need an interactive rename decision, enumerating the entities", async () => {
    const h = harness();
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
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => committeeBundle()),
      planImpl,
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(applyImpl).not.toHaveBeenCalled();
    // The abort log names the affected entities and the interactive fallback.
    const [, message] = silentLog.error.mock.calls[0] as [unknown, string];
    expect(message).toContain('committee-role "president"');
    expect(message).toContain("Export & Import");
  });

  it("aborts on a post-seed target when the bundle renamed a seed-created key-weak default (D1) — end-to-end", async () => {
    // The seed creates a default induction template; the source club renamed
    // theirs, so the bundle's template has no exact (name, version) match and
    // the seeded template becomes a rename candidate. The whole import must
    // refuse (nothing written) and tell the operator what to resolve
    // interactively. This runs the REAL plan pipeline (no planImpl stub).
    const h = harness(
      {},
      {
        inductionTemplates: [
          {
            id: "tpl-seed",
            name: "New Member Induction",
            version: "1",
            kind: "NEW_MEMBER",
            sourceLabel: null,
            isActive: true,
            sections: [],
          },
        ],
      },
    );
    const bytes = inductionBundle("Alpine Club Induction", "2");

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => bytes),
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(result.detail).toBe("plan requires interactive rename resolution");
    // Nothing was written — the abort happens at plan time.
    expect(h.create).not.toHaveBeenCalled();
    expect(h.$transaction).not.toHaveBeenCalled();
    expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    // The log enumerates the ambiguous entity and points at the interactive
    // import as the fallback.
    const [structured, message] = silentLog.error.mock.calls[0] as [
      { entities: string[] },
      string,
    ];
    expect(structured.entities).toEqual([
      "induction-template:Alpine Club Induction/2",
    ]);
    expect(message).toContain('induction-template "Alpine Club Induction/2"');
    expect(message).toContain("Export & Import");
    expect(message).toContain("Nothing was written");
  });

  it("rejects a malformed (non-zip) bundle atomically — nothing written", async () => {
    const h = harness();

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => strToU8("this is not a zip")),
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("failed");
    expect(h.create).not.toHaveBeenCalled();
    expect(runDatabaseBackup).not.toHaveBeenCalled();
  });
});

describe("runConfigBootstrapImport — concurrency (S4/R1)", () => {
  it("refuses calmly (INFO) when another writer configured the target between the boot probe and the in-lock re-check", async () => {
    const h = harness();

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => committeeBundle()),
      // Simulate the TOCTOU window: another replica's bootstrap commits after
      // this replica's boot probe but before its apply acquires the lock.
      planImpl: async (db, bytes, opts) => {
        const plan = await buildImportPlan(db, bytes, opts);
        h.state.bootstrapImports = 1;
        return plan;
      },
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("refused-configured");
    expect(result.detail).toContain("another writer");
    // The losing replica writes nothing — the in-lock re-check rolled the
    // transaction back before any category apply or marker write.
    expect(h.create).not.toHaveBeenCalled();
    expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    // The healthy multi-replica outcome is INFO — never a WARN or ERROR.
    expect(silentLog.info).toHaveBeenCalled();
    expect(silentLog.warn).not.toHaveBeenCalled();
    expect(silentLog.error).not.toHaveBeenCalled();
  });

  it("the backup waiver requires the branded proof — a bare string no longer compiles (S2)", () => {
    const neverInvoked = () =>
      applyConfigImport({
        prisma: {} as PrismaClient,
        bundleBytes: new Uint8Array(),
        actorMemberId: "admin-1",
        expectedFingerprint: "f",
        mode: "overwrite",
        // @ts-expect-error — the skip variant is an object carrying the
        // BootstrapEmptyTargetProof minted only by assessBootstrapReadiness;
        // the old bare string must fail to compile.
        preApplyBackup: "skip-empty-bootstrap",
      });
    // Compile-time assertion only; the call is never executed.
    expect(typeof neverInvoked).toBe("function");
  });
});

describe("runConfigBootstrapImport — I/O + resilience", () => {
  it("is a silent no-op when CONFIG_BUNDLE_IMPORT_PATH is unset", async () => {
    const { db } = harness();
    const readBundleFile = vi.fn();
    const statBundleFile = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: undefined,
      log: silentLog,
      statBundleFile,
      readBundleFile,
    });

    expect(result.outcome).toBe("disabled");
    expect(statBundleFile).not.toHaveBeenCalled();
    expect(readBundleFile).not.toHaveBeenCalled();
  });

  it("continues boot (unreadable) when the file cannot be statted", async () => {
    const { db } = harness();
    const readBundleFile = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/missing.zip",
      log: silentLog,
      statBundleFile: async () => {
        throw new Error("ENOENT: no such file");
      },
      readBundleFile,
    });

    expect(result.outcome).toBe("unreadable");
    expect(readBundleFile).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("continues boot (unreadable) when the path is not a regular file, without reading it", async () => {
    const { db } = harness();
    const readBundleFile = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: "/dev/random",
      log: silentLog,
      statBundleFile: async () => ({ size: 0, isFile: false }),
      readBundleFile,
    });

    expect(result.outcome).toBe("unreadable");
    expect(readBundleFile).not.toHaveBeenCalled();
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("refuses (refused-invalid) an over-cap file before reading it into memory", async () => {
    const { db } = harness();
    const readBundleFile = vi.fn();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/huge.zip",
      log: silentLog,
      statBundleFile: async () => ({
        size: MAX_BUNDLE_BYTES + 1,
        isFile: true,
      }),
      readBundleFile,
    });

    expect(result.outcome).toBe("refused-invalid");
    expect(result.detail).toContain(`${MAX_BUNDLE_BYTES}`);
    expect(readBundleFile).not.toHaveBeenCalled();
    expect(silentLog.error).toHaveBeenCalled();
  });

  it("continues boot (unreadable) when the file cannot be read", async () => {
    const { db } = harness();

    const result = await runConfigBootstrapImport({
      db,
      path: "/deploy/missing.zip",
      log: silentLog,
      statBundleFile: async () => ({ size: 1024, isFile: true }),
      readBundleFile: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(result.outcome).toBe("unreadable");
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("fails closed (failed, nothing written) when the emptiness probe itself errors", async () => {
    const h = harness();
    (h.db as unknown as { booking: { count: () => Promise<number> } }).booking =
      {
        count: async () => {
          throw new Error("connection refused");
        },
      };
    const seams = fileSeams(() => committeeBundle());

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...seams,
      applyImpl: applyConfigImport,
    });

    expect(result.outcome).toBe("failed");
    expect(seams.readBundleFile).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(silentLog.error).toHaveBeenCalled();
  });

  it("never throws — an apply that throws is caught and reported as failed", async () => {
    const h = harness();
    const applyImpl = vi.fn(async () => {
      throw new Error("boom in apply");
    });

    const result = await runConfigBootstrapImport({
      db: h.db,
      path: "/deploy/bundle.zip",
      log: silentLog,
      ...fileSeams(() => committeeBundle()),
      applyImpl: applyImpl as never,
    });

    expect(result.outcome).toBe("failed");
    expect(h.create).not.toHaveBeenCalled();
    expect(silentLog.error).toHaveBeenCalled();
  });
});
