import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  anonymizeExpiredAuditRequestData,
  archiveEligibleAuditLogs,
  getAuditLogRetentionCutoffs,
  isAuditLogArchivable,
  isAuditLogRetentionCritical,
  pruneAuditArchive,
  pruneExpiredAuditLogs,
  runAuditLogRetentionJob,
} from "@/lib/audit-retention";

function mockDb() {
  return {
    auditLog: {
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  };
}

function mockArchiveDb() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function archiveRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    action: "admin.member.view",
    memberId: "admin-1",
    targetId: "member-1",
    details: "Viewed member cardNumber=4242 4242 4242 4242",
    ipAddress: "203.0.113.10",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    actorMemberId: "admin-1",
    subjectMemberId: "member-1",
    entityType: "Member",
    entityId: "member-1",
    category: "admin",
    severity: "info",
    outcome: "success",
    summary: "Viewed member profile",
    metadata: {
      rawBody: { token: "secret" },
      changedFields: ["email"],
      safeCardReference: "4242 4242 4242 4242",
    },
    requestId: "req-1",
    userAgent: "Vitest",
    retentionClass: "sensitive_access",
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    archivedAt: null,
    incidentPreserved: false,
    ...overrides,
  };
}

// #2506: the prune test asserts WHICH rows actually survive — not merely the
// query shape — by applying the real `where` to an in-memory table through the
// shared `matchesWhere` (#3434). Removing the archive gate then reddens a test
// by showing an unarchived row genuinely deleted (the data loss the gate exists
// to prevent).
//
// `severity` is REQUIRED on a fixture row, not optional as it once was, so each
// row states whether it is null rather than leaving it to a default. The shared
// evaluator follows PostgreSQL's three-valued logic and THROWS on a negation over
// a NULL column, so a predicate that left the null case to `NOT` could not pass
// here by accident. #3524 made the unclassified branch name the null case
// explicitly; "null severity" below pins the decided answer.
type PruneRow = {
  id: string;
  retentionClass: string | null;
  severity: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  archivedAt: Date | null;
  // #3939: optional on the fixture because the column is NOT NULL DEFAULT false;
  // the fake store fills the same default, so the prune's `incidentPreserved`
  // conditions meet a real value on every row, never a missing column the
  // shared evaluator would (rightly) refuse.
  incidentPreserved?: boolean;
};

// The main prune's `where` (#3939): the normal branches, AND a preserved row
// must also be past its ten-year cap from creation.
function expectedPruneWhere(
  normalBranches: unknown,
  preservedCutoff: Date
): Record<string, unknown> {
  return {
    AND: [
      {
        OR: [
          { incidentPreserved: false },
          { createdAt: { lt: preservedCutoff } },
        ],
      },
    ],
    OR: normalBranches,
  };
}

function makeFakeAuditDb(rows: PruneRow[]) {
  const state = rows.map((row) => ({ incidentPreserved: false, ...row }));
  return {
    db: {
      auditLog: {
        updateMany: async () => ({ count: 0 }),
        findMany: async () => [],
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const doomed = state.filter((row) => matchesWhere(row, where));
          for (const row of doomed) {
            state.splice(state.indexOf(row), 1);
          }
          return { count: doomed.length };
        },
      },
    },
    remainingIds: () => state.map((row) => row.id),
  };
}

describe("audit retention lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUDIT_ARCHIVE_DATABASE_URL;
    delete process.env.AUDIT_LOG_ARCHIVE_DATABASE_URL;
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findMany.mockResolvedValue([]);
  });

  it("calculates policy cutoffs and classifies edge cases conservatively", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    expect(getAuditLogRetentionCutoffs(now)).toEqual({
      requestData: new Date("2026-02-09T00:00:00.000Z"),
      archive: new Date("2025-05-10T00:00:00.000Z"),
      archivePrune: new Date("2019-05-10T00:00:00.000Z"),
      criticalMain: new Date("2019-05-10T00:00:00.000Z"),
      incidentPreserved: new Date("2016-05-10T00:00:00.000Z"),
    });
    // #3939: a cutoff taken on 29 Feb lands on 28 Feb in a year without one,
    // never 1 Mar, which would delete rows up to a day early.
    expect(
      getAuditLogRetentionCutoffs(new Date("2036-02-29T03:30:00.000Z"))
    ).toMatchObject({
      archivePrune: new Date("2029-02-28T03:30:00.000Z"),
      criticalMain: new Date("2029-02-28T03:30:00.000Z"),
      incidentPreserved: new Date("2026-02-28T03:30:00.000Z"),
    });
    expect(
      isAuditLogRetentionCritical({
        action: "admin.member.view",
        category: "admin",
      })
    ).toBe(false);
    expect(
      isAuditLogRetentionCritical({
        action: "privacy.data_export.downloaded",
        category: "privacy",
        severity: "critical",
      })
    ).toBe(true);
    expect(
      isAuditLogArchivable(
        {
          action: "admin.member.view",
          category: "admin",
          retentionClass: "sensitive_access",
          archivedAt: null,
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(true);
    expect(
      isAuditLogArchivable(
        {
          action: "booking.confirmed",
          category: "booking",
          retentionClass: "critical",
          archivedAt: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
    expect(
      isAuditLogArchivable(
        {
          action: "system.request.debug",
          category: "system",
          retentionClass: "diagnostic_high_volume",
          archivedAt: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("purges raw IP address and user-agent after 90 days unless incident-preserved", async () => {
    mocks.updateMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-05-10T00:00:00.000Z");

    const result = await anonymizeExpiredAuditRequestData(mockDb() as never, now);

    expect(result).toEqual({
      cutoff: new Date("2026-02-09T00:00:00.000Z"),
      anonymized: 3,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date("2026-02-09T00:00:00.000Z") },
        incidentPreserved: false,
        OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
      },
      data: {
        ipAddress: null,
        userAgent: null,
      },
    });
  });

  it("safely skips archive movement and pruning when archive DB is not configured", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    const result = await runAuditLogRetentionJob({
      db: mockDb() as never,
      archiveDatabaseUrl: null,
      now,
    });

    expect(result.archive).toMatchObject({
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      archived: 0,
      deletedFromMain: 0,
    });
    expect(result.archivePrune).toMatchObject({
      configured: false,
      skipped: true,
      reason: "archive-db-not-configured",
      pruned: 0,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { job: "audit-retention", reason: "archive-db-not-configured" },
      "Audit archive skipped because no archive database is configured"
    );
  });

  it("archives eligible non-critical rows and removes them from the main DB", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const archiveDb = mockArchiveDb();
    mocks.findMany.mockResolvedValue([
      archiveRow({ id: "audit-1" }),
      archiveRow({
        id: "audit-2",
        incidentPreserved: true,
        ipAddress: "198.51.100.5",
        userAgent: "Incident UA",
      }),
    ]);
    mocks.deleteMany.mockResolvedValue({ count: 2 });

    const result = await archiveEligibleAuditLogs(
      mockDb() as never,
      archiveDb,
      now,
      25
    );

    expect(result).toMatchObject({
      configured: true,
      skipped: false,
      selected: 2,
      archived: 2,
      deletedFromMain: 2,
    });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date("2025-05-10T00:00:00.000Z") },
        archivedAt: null,
        retentionClass: { in: ["sensitive_access", "standard"] },
      },
      orderBy: { createdAt: "asc" },
      take: 25,
      select: expect.objectContaining({
        incidentPreserved: true,
        metadata: true,
        userAgent: true,
      }),
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["audit-1", "audit-2"] } },
    });

    const firstInsert = archiveDb.$executeRaw.mock.calls[0][0] as {
      values: unknown[];
    };
    expect(firstInsert.values[4]).toContain("cardNumber=[REDACTED]");
    expect(firstInsert.values[5]).toBeNull();
    expect(firstInsert.values[15]).toContain('"rawBody":"[REDACTED]"');
    expect(firstInsert.values[15]).toContain("[REDACTED_CARD]");
    expect(firstInsert.values[17]).toBeNull();

    const secondInsert = archiveDb.$executeRaw.mock.calls[1][0] as {
      values: unknown[];
    };
    expect(secondInsert.values[5]).toBe("198.51.100.5");
    expect(secondInsert.values[17]).toBe("Incident UA");
  });

  it("keeps critical records guarded by a 7-year main DB retention cutoff", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    mocks.deleteMany.mockResolvedValue({ count: 4 });

    const result = await pruneExpiredAuditLogs(mockDb() as never, now);

    expect(result).toEqual({
      cutoff: new Date("2019-05-10T00:00:00.000Z"),
      deleted: 4,
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: expectedPruneWhere(
        expect.arrayContaining([
          {
            retentionClass: "critical",
            createdAt: { lt: new Date("2019-05-10T00:00:00.000Z") },
            expiresAt: { lt: now },
          },
        ]),
        new Date("2016-05-10T00:00:00.000Z")
      ),
    });
  });

  it("prunes archive rows older than 7 years", async () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const archiveDb = mockArchiveDb();
    archiveDb.$executeRaw.mockResolvedValue(9);

    const result = await pruneAuditArchive(archiveDb, now);

    expect(result).toEqual({
      configured: true,
      skipped: false,
      cutoff: new Date("2019-05-10T00:00:00.000Z"),
      pruned: 9,
    });
    const pruneQuery = archiveDb.$executeRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(pruneQuery.strings.join("")).toContain(
      'DELETE FROM "AuditLogArchive"'
    );
    // #3939: a preserved copy skips the seven-year cutoff and goes at its
    // ten-year cap. The row-level behaviour is pinned under "incident-preserved
    // rows" below; this pins the bound values.
    expect(pruneQuery.values).toEqual([
      new Date("2019-05-10T00:00:00.000Z"),
      new Date("2016-05-10T00:00:00.000Z"),
    ]);
  });

  // -------------------------------------------------------------------------
  // #2506 — prune must NEVER outrun archival. The archive captures 500 rows a
  // night; a sustained high-volume club could otherwise have an expired-but-
  // unarchived row deleted before the archive ever received it.
  // -------------------------------------------------------------------------
  describe("prune archive gate", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    // sensitive_access expires at createdAt + 24 months; a row created in early
    // 2023 is both archive-eligible (>12 months old) and expired by `now`, so it
    // is exactly the row a 500/night archive backlog can strand.
    function unarchivedExpiredSensitive(overrides: Partial<PruneRow> = {}): PruneRow {
      return {
        id: "sensitive-unarchived",
        retentionClass: "sensitive_access",
        severity: "info",
        createdAt: new Date("2023-01-01T00:00:00.000Z"),
        expiresAt: new Date("2025-01-01T00:00:00.000Z"),
        archivedAt: null,
        ...overrides,
      };
    }

    it("retains an expired but unarchived archivable row while the archive is active", async () => {
      const fake = makeFakeAuditDb([unarchivedExpiredSensitive()]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // The row is expired, but not yet archived: prune must leave it alone.
      // Delete the `archivedAt: { not: null }` gate in pruneExpiredAuditLogs and
      // this reddens with the unarchived row pruned — i.e. silent data loss.
      expect(result.deleted).toBe(0);
      expect(fake.remainingIds()).toEqual(["sensitive-unarchived"]);
    });

    it("prunes the same archivable row once it is provably archived", async () => {
      const fake = makeFakeAuditDb([
        unarchivedExpiredSensitive({
          id: "sensitive-archived",
          archivedAt: new Date("2024-02-01T00:00:00.000Z"),
        }),
      ]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // Proves the gate keys on the durable `archivedAt` marker, not a blanket
      // class exclusion: an archived copy exists, so the source row may go.
      expect(result.deleted).toBe(1);
      expect(fake.remainingIds()).toEqual([]);
    });

    it("prunes an expired unarchived archivable row by expiry when NO archive is configured", async () => {
      const fake = makeFakeAuditDb([unarchivedExpiredSensitive()]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: false,
      });

      // No archive to protect the row and nowhere for the data to go, so data
      // minimisation still deletes it at expiry. A gate applied unconditionally
      // would over-retain forever and redden here.
      expect(result.deleted).toBe(1);
      expect(fake.remainingIds()).toEqual([]);
    });

    it("always prunes expired diagnostic_high_volume and unclassified rows even with the archive active", async () => {
      const fake = makeFakeAuditDb([
        {
          id: "diagnostic",
          retentionClass: "diagnostic_high_volume",
          severity: "info",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
          expiresAt: new Date("2025-04-01T00:00:00.000Z"),
          archivedAt: null,
        },
        {
          id: "legacy-null",
          retentionClass: null,
          severity: "info",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          expiresAt: new Date("2025-01-01T00:00:00.000Z"),
          archivedAt: null,
        },
        unarchivedExpiredSensitive(),
      ]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      // The gate is scoped to the archivable classes only: never-archived rows
      // still prune on expiry, while the unarchived archivable row survives.
      expect(result.deleted).toBe(2);
      expect(fake.remainingIds()).toEqual(["sensitive-unarchived"]);
    });

    it("gates the job's main prune on archival when an archive DB is configured", async () => {
      const archiveDb = mockArchiveDb();

      const result = await runAuditLogRetentionJob({
        db: mockDb() as never,
        archiveDb,
        now,
      });

      expect(result.archive.configured).toBe(true);
      // findMany returns [] this run, so the archive step deletes nothing and the
      // only deleteMany is the main prune — assert it carries the archive gate.
      expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
      expect(mocks.deleteMany).toHaveBeenCalledWith({
        where: expectedPruneWhere(
          expect.arrayContaining([
            {
              retentionClass: { in: ["sensitive_access", "standard"] },
              expiresAt: { lt: now },
              archivedAt: { not: null },
            },
          ]),
          new Date("2016-05-10T00:00:00.000Z")
        ),
      });
    });

    it("leaves the job's main prune ungated when no archive DB is configured", async () => {
      const result = await runAuditLogRetentionJob({
        db: mockDb() as never,
        archiveDatabaseUrl: null,
        now,
      });

      expect(result.archive.configured).toBe(false);
      // Without an archive, the archivable clause carries no archivedAt gate.
      expect(mocks.deleteMany).toHaveBeenCalledWith({
        where: expectedPruneWhere(
          expect.arrayContaining([
            {
              retentionClass: { in: ["sensitive_access", "standard"] },
              expiresAt: { lt: now },
            },
          ]),
          new Date("2016-05-10T00:00:00.000Z")
        ),
      });
    });

    it("keeps the nightly archive batch bounded at 500 rows by default", async () => {
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now);

      // The bounded batch is what makes the gate necessary; assert it stays 500.
      expect(mocks.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 })
      );
    });

    it("warns of an archive backlog when the nightly batch comes back full", async () => {
      // A full batch means more archivable rows remain unarchived this run. Since
      // the #2506 gate now retains their expired members past the retention
      // window, that over-retention would otherwise be silent — assert the warn.
      mocks.findMany.mockResolvedValueOnce([
        archiveRow(),
        archiveRow({ id: "audit-2" }),
      ]);
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now, 2);

      // Drop the `rows.length === batchSize` warn and this reddens — the drift
      // signal disappears.
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "archive-backlog", batchSize: 2 }),
        expect.stringContaining("Audit archive batch was full")
      );
    });

    it("stays silent when the nightly batch is not full (archive is keeping up)", async () => {
      mocks.findMany.mockResolvedValueOnce([archiveRow()]);
      const archiveDb = mockArchiveDb();

      await archiveEligibleAuditLogs(mockDb() as never, archiveDb, now, 2);

      // One row against a batch cap of two: no backlog, so no spurious warning.
      // A warn keyed on anything looser than a full batch would redden here.
      expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // #3524 — an unclassified row whose severity was never set. Owner decision,
  // 6 Oct 2026: "Prune them, count first" (the count was waived on 10 Oct
  // 2026, see #3937) — a null severity is NOT critical, so such a row ages out
  // on its own expiry like any other non-critical unclassified row. The branch
  // used to read `NOT: { severity: "critical" }`, which PostgreSQL evaluates to
  // unknown on a NULL and therefore retained the row forever. The shared evaluator throws on that negation over NULL, so
  // reverting the predicate reddens these tests rather than passing them.
  // -------------------------------------------------------------------------
  describe("null severity on an unclassified row (#3524)", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    function unclassified(overrides: Partial<PruneRow> & { id: string }): PruneRow {
      return {
        retentionClass: null,
        severity: null,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        expiresAt: new Date("2025-01-01T00:00:00.000Z"),
        archivedAt: null,
        ...overrides,
      };
    }

    for (const archiveActive of [true, false]) {
      it(`prunes an expired null-severity row and keeps a recent one (archive ${
        archiveActive ? "active" : "not configured"
      })`, async () => {
        const fake = makeFakeAuditDb([
          unclassified({ id: "null-expired" }),
          unclassified({
            id: "null-recent",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            expiresAt: new Date("2033-01-01T00:00:00.000Z"),
          }),
        ]);

        const result = await pruneExpiredAuditLogs(fake.db as never, now, {
          archiveActive,
        });

        expect(result.deleted).toBe(1);
        expect(fake.remainingIds()).toEqual(["null-recent"]);
      });
    }

    it("still keeps a critical unclassified row until seven years, and an unexpiring null-severity row forever", async () => {
      const fake = makeFakeAuditDb([
        // Critical, expired, but created inside the 7-year window: kept.
        unclassified({ id: "critical-young", severity: "critical" }),
        // Critical and older than the 7-year cutoff (2019-05-10): pruned, as before.
        unclassified({
          id: "critical-old",
          severity: "critical",
          createdAt: new Date("2018-01-01T00:00:00.000Z"),
        }),
        // `expiresAt: null` is the deliberate keep-forever escape hatch; #3524
        // does not touch it, null severity or not.
        unclassified({ id: "null-no-expiry", expiresAt: null }),
        // A non-critical classified severity on the same branch: pruned, as before.
        unclassified({ id: "info-expired", severity: "info" }),
        unclassified({ id: "null-expired" }),
      ]);

      const result = await pruneExpiredAuditLogs(fake.db as never, now, {
        archiveActive: true,
      });

      expect(result.deleted).toBe(3);
      expect(fake.remainingIds()).toEqual(["critical-young", "null-no-expiry"]);
    });

    it("names the null case explicitly in the predicate, not through a NOT over a nullable column", async () => {
      await pruneExpiredAuditLogs(mockDb() as never, now, { archiveActive: true });

      // Pins the SQL shape, not just the in-memory answer: the evaluator above
      // models PostgreSQL, but Prisma's own `not` on a nullable column is what
      // reaches the database, so the IS NULL arm must be present in its own right.
      expect(mocks.deleteMany).toHaveBeenCalledWith({
        where: expectedPruneWhere(
          expect.arrayContaining([
            {
              AND: [
                {
                  OR: [
                    { retentionClass: null },
                    { retentionClass: { notIn: ["critical", "sensitive_access", "diagnostic_high_volume", "standard"] } },
                  ],
                },
                { expiresAt: { lt: now } },
                { OR: [{ severity: null }, { severity: { not: "critical" } }] },
              ],
            },
          ]),
          new Date("2016-05-10T00:00:00.000Z")
        ),
      });
    });
  });

  // -------------------------------------------------------------------------
  // #3940 — a stored retentionClass outside the known four. The column is free
  // text, so a value nothing classifies (a typo, raw SQL, a restore) matched no
  // prune branch and was kept forever. Owner decision, 17 Oct 2026: read it as
  // unclassified, exactly like a NULL class.
  // -------------------------------------------------------------------------
  describe("unknown retention class (#3940)", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");

    function unknownClass(overrides: Partial<PruneRow> & { id: string }): PruneRow {
      return {
        retentionClass: "standrad",
        severity: null,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        expiresAt: new Date("2025-01-01T00:00:00.000Z"),
        archivedAt: null,
        ...overrides,
      };
    }

    for (const archiveActive of [true, false]) {
      it(`ages an unknown-class row out like a NULL-class row (archive ${
        archiveActive ? "active" : "not configured"
      })`, async () => {
        const fake = makeFakeAuditDb([
          unknownClass({ id: "unknown-expired" }),
          unknownClass({ id: "unknown-info-expired", severity: "info" }),
          unknownClass({
            id: "unknown-recent",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            expiresAt: new Date("2033-01-01T00:00:00.000Z"),
          }),
          // Critical severity: kept until seven years from creation, as a NULL class is.
          unknownClass({ id: "unknown-critical-young", severity: "critical" }),
          unknownClass({
            id: "unknown-critical-old",
            severity: "critical",
            createdAt: new Date("2018-01-01T00:00:00.000Z"),
          }),
          // The keep-forever escape hatch still holds.
          unknownClass({ id: "unknown-no-expiry", expiresAt: null }),
          // The incident floor still holds: expired, past seven years, inside ten.
          unknownClass({
            id: "unknown-preserved",
            createdAt: new Date("2018-01-01T00:00:00.000Z"),
            incidentPreserved: true,
          }),
        ]);

        const result = await pruneExpiredAuditLogs(fake.db as never, now, { archiveActive });

        expect(result.deleted).toBe(3);
        expect(fake.remainingIds()).toEqual([
          "unknown-recent",
          "unknown-critical-young",
          "unknown-no-expiry",
          "unknown-preserved",
        ]);
      });
    }

    it("reads an unknown stored class as no class when asking whether a row is critical", () => {
      expect(
        isAuditLogRetentionCritical({ action: "X", category: "system", severity: "info", retentionClass: "standrad" })
      ).toBe(false);
      expect(
        isAuditLogRetentionCritical({ action: "X", category: null, severity: "critical", retentionClass: "standrad" })
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // #3939 — incident-preserved rows. The app sets `incidentPreserved` itself,
  // on the audit entry for an admin capacity hold or force-confirm that
  // overbooked the lodge. Owner decision, 11 Oct 2026: such a row skips its
  // normal expiry but is still deleted TEN YEARS FROM CREATION, from the main
  // table and the archive alike: at the later of its normal rule and the cap,
  // so never sooner than an unpreserved twin. Before #3939 the prunes ignored
  // the flag and deleted a preserved row at its expiry.
  //
  // `now` is 2026-05-10, so the seven-year cutoff is 2019-05-10 and the
  // ten-year cap is 2016-05-10T00:00:00.000Z. A row created exactly at the cap
  // is kept (the bound is strict); one created a millisecond earlier goes.
  // -------------------------------------------------------------------------
  describe("incident-preserved rows (#3939)", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const preservedCap = new Date("2016-05-10T00:00:00.000Z");
    const justPastCap = new Date(preservedCap.getTime() - 1);
    const justInsideCap = preservedCap;
    // Older than the 7-year critical cutoff (2019-05-10) but inside the 10-year
    // cap, and long expired: the only thing that can keep any of these rows is
    // the preservation flag.
    const pastNormalRetention = new Date("2018-01-01T00:00:00.000Z");
    const expired = new Date("2025-01-01T00:00:00.000Z");

    describe("main prune: a preserved row skips its normal expiry", () => {
      type Branch = {
        name: string;
        row: Omit<PruneRow, "id" | "incidentPreserved">;
        // The archivable classes are gated on `archivedAt` while an archive is
        // active; these branches only prune when it is (or none is configured).
        archiveActive: boolean;
      };

      const branches: Branch[] = [
        {
          name: "archivable class, archived, archive active",
          row: {
            retentionClass: "sensitive_access",
            severity: "info",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: new Date("2024-02-01T00:00:00.000Z"),
          },
          archiveActive: true,
        },
        {
          name: "archivable class, no archive configured",
          row: {
            retentionClass: "standard",
            severity: "info",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: false,
        },
        {
          name: "diagnostic_high_volume",
          row: {
            retentionClass: "diagnostic_high_volume",
            severity: "info",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "unclassified, not critical",
          row: {
            retentionClass: null,
            severity: "important",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "critical class, past the seven-year cutoff",
          row: {
            retentionClass: "critical",
            severity: "critical",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "unclassified critical severity, past the seven-year cutoff",
          row: {
            retentionClass: null,
            severity: "critical",
            createdAt: pastNormalRetention,
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: false,
        },
      ];

      // Each branch gets a PAIR of rows differing only in the flag: the
      // preserved one survives, its unpreserved twin still goes. Drop the
      // preserved condition and every preserved row here is deleted.
      for (const branch of branches) {
        it(`keeps a preserved row and prunes its unpreserved twin: ${branch.name}`, async () => {
          const fake = makeFakeAuditDb([
            { id: "preserved", incidentPreserved: true, ...branch.row },
            { id: "unpreserved", incidentPreserved: false, ...branch.row },
          ]);

          const result = await pruneExpiredAuditLogs(fake.db as never, now, {
            archiveActive: branch.archiveActive,
          });

          expect(result.deleted).toBe(1);
          expect(fake.remainingIds()).toEqual(["preserved"]);
        });
      }

      it("keeps every preserved row inside the cap across all branches in one run", async () => {
        const rows: PruneRow[] = branches.flatMap((branch, index) => [
          { id: `preserved-${index}`, incidentPreserved: true, ...branch.row },
          { id: `unpreserved-${index}`, incidentPreserved: false, ...branch.row },
        ]);
        // With no archive configured every branch above is prune-eligible.
        const fake = makeFakeAuditDb(rows);

        const result = await pruneExpiredAuditLogs(fake.db as never, now, {
          archiveActive: false,
        });

        expect(result.deleted).toBe(branches.length);
        expect(fake.remainingIds()).toEqual(
          branches.map((_, index) => `preserved-${index}`)
        );
      });
    });

    describe("main prune: the ten-year cap from creation", () => {
      // Shapes the NORMAL rules would prune, so the only thing deciding between
      // the two rows of each pair is the cap. A preserved row goes at the later
      // of its normal rule and ten years from `createdAt`.
      const shapes: Array<{
        name: string;
        row: Omit<PruneRow, "id" | "createdAt" | "incidentPreserved">;
        archiveActive: boolean;
      }> = [
        {
          name: "critical, expired",
          row: {
            retentionClass: "critical",
            severity: "critical",
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "unclassified, not critical, expired",
          row: {
            retentionClass: null,
            severity: "important",
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "diagnostic_high_volume, expired",
          row: {
            retentionClass: "diagnostic_high_volume",
            severity: "info",
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: true,
        },
        {
          name: "archivable, archived, archive active",
          row: {
            retentionClass: "sensitive_access",
            severity: "info",
            expiresAt: expired,
            archivedAt: new Date("2024-02-01T00:00:00.000Z"),
          },
          archiveActive: true,
        },
        {
          name: "archivable, no archive configured",
          row: {
            retentionClass: "standard",
            severity: "info",
            expiresAt: expired,
            archivedAt: null,
          },
          archiveActive: false,
        },
      ];

      for (const shape of shapes) {
        it(`deletes a preserved row just past ten years and keeps one just inside: ${shape.name}`, async () => {
          const fake = makeFakeAuditDb([
            {
              id: "preserved-past-cap",
              incidentPreserved: true,
              createdAt: justPastCap,
              ...shape.row,
            },
            {
              id: "preserved-inside-cap",
              incidentPreserved: true,
              createdAt: justInsideCap,
              ...shape.row,
            },
          ]);

          const result = await pruneExpiredAuditLogs(fake.db as never, now, {
            archiveActive: shape.archiveActive,
          });

          // Remove the `createdAt < cap` arm and the past-cap row survives;
          // remove the whole preserved condition and the inside-cap row goes.
          expect(result.deleted).toBe(1);
          expect(fake.remainingIds()).toEqual(["preserved-inside-cap"]);
        });
      }

      // Preservation never makes a row shorter-lived than its unpreserved twin:
      // past the cap, a row the normal rules keep is still kept.
      it("keeps a preserved row with no expiresAt past ten years, like its twin", async () => {
        const row = {
          retentionClass: "critical",
          severity: "critical",
          createdAt: justPastCap,
          expiresAt: null,
          archivedAt: null,
        };
        const fake = makeFakeAuditDb([
          { id: "preserved", incidentPreserved: true, ...row },
          { id: "unpreserved", incidentPreserved: false, ...row },
        ]);

        const result = await pruneExpiredAuditLogs(fake.db as never, now, {
          archiveActive: false,
        });

        expect(result.deleted).toBe(0);
        expect(fake.remainingIds()).toEqual(["preserved", "unpreserved"]);
      });

      it("keeps a preserved unarchived archivable row past ten years behind the archive gate", async () => {
        const row = {
          retentionClass: "sensitive_access",
          severity: "info",
          createdAt: justPastCap,
          expiresAt: new Date("2018-05-10T00:00:00.000Z"),
          archivedAt: null,
        };
        const fake = makeFakeAuditDb([
          { id: "preserved", incidentPreserved: true, ...row },
          { id: "unpreserved", incidentPreserved: false, ...row },
        ]);

        // Archive active: the row leaves through archival and the archive
        // prune, never straight out of the main table (#2506).
        const result = await pruneExpiredAuditLogs(fake.db as never, now, {
          archiveActive: true,
        });

        expect(result.deleted).toBe(0);
        expect(fake.remainingIds()).toEqual(["preserved", "unpreserved"]);
      });
    });

    // The archive prune is raw SQL, so the shared Prisma `where` evaluator
    // cannot apply it. `applyArchivePrune` below evaluates the statement's own
    // WHERE text, with its bound values, against an in-memory archive table: a
    // tiny parser for exactly the grammar that statement uses (quoted column,
    // `<` or `=`, a bound value or boolean literal, AND, OR, parentheses), which
    // throws on anything else rather than guess.
    describe("archive prune", () => {
      type ArchiveFixture = {
        id: string;
        createdAt: Date;
        incidentPreserved: boolean;
      };

      function applyArchivePrune(
        query: { strings: readonly string[]; values: readonly unknown[] },
        rows: ArchiveFixture[]
      ): string[] {
        const text = query.strings
          .map((part, index) =>
            index < query.values.length ? `${part} $${index} ` : part
          )
          .join("");
        const match = /^\s*DELETE FROM "AuditLogArchive"\s+WHERE\s+([\s\S]*)$/.exec(
          text
        );
        if (!match) throw new Error(`unexpected archive prune SQL: ${text}`);
        // Sticky: each token must start exactly where the last one ended, after
        // whitespace only, so an unrecognised character throws instead of being
        // skipped (a skip would read `!= false` as `= false`). The comparison
        // operators PostgreSQL has and this parser does not model are tokenised
        // whole so they can be rejected by name below, never half-read.
        const tokens: string[] = [];
        const tokenPattern =
          /\s*("[A-Za-z]+"|\$\d+|!=|<>|<=|>=|[()<>=]|[A-Za-z]+)/y;
        const where = match[1];
        tokenPattern.lastIndex = 0;
        while (!/^\s*$/.test(where.slice(tokenPattern.lastIndex))) {
          const start = tokenPattern.lastIndex;
          const token = tokenPattern.exec(where);
          if (!token) {
            throw new Error(
              `archive prune SQL: unrecognised text at ${start}: ${where.slice(start)}`
            );
          }
          tokens.push(token[1]);
        }

        type Node = (row: ArchiveFixture) => boolean;
        let position = 0;
        const peek = () => tokens[position];
        const take = (expected?: string) => {
          const token = tokens[position++];
          if (token === undefined || (expected && token !== expected)) {
            throw new Error(`archive prune SQL: expected ${expected ?? "a token"}, got ${token}`);
          }
          return token;
        };
        const operand = (): unknown => {
          const token = take();
          if (token.startsWith("$")) return query.values[Number(token.slice(1))];
          if (token === "false") return false;
          if (token === "true") return true;
          throw new Error(`archive prune SQL: unsupported operand ${token}`);
        };
        const comparison = (): Node => {
          if (peek() === "(") {
            take("(");
            const inner = disjunction();
            take(")");
            return inner;
          }
          const column = take();
          if (!/^"[A-Za-z]+"$/.test(column)) {
            throw new Error(`archive prune SQL: unsupported term ${column}`);
          }
          const key = column.slice(1, -1) as keyof ArchiveFixture;
          const op = take();
          if (op !== "<" && op !== "=") {
            // `!=`, `<>`, `<=`, `>=`, `>` and anything else: refused at parse
            // time, so a mutated operator can never be evaluated as a modelled one.
            throw new Error(`archive prune SQL: unsupported operator ${op}`);
          }
          const right = operand();
          return (row) => {
            const left = row[key];
            if (left === undefined || left === null) {
              throw new Error(`archive prune SQL: fixture lacks ${key}`);
            }
            const leftIsDate = left instanceof Date;
            const rightIsDate = right instanceof Date;
            if (op === "<") {
              if (!leftIsDate || !rightIsDate) {
                throw new Error(`archive prune SQL: \`<\` needs two dates (${key})`);
              }
              return left.getTime() < right.getTime();
            }
            if (leftIsDate || rightIsDate) {
              if (!leftIsDate || !rightIsDate) {
                throw new Error(`archive prune SQL: \`=\` mixes a date and a non-date (${key})`);
              }
              return left.getTime() === right.getTime();
            }
            if (typeof left !== typeof right) {
              throw new Error(`archive prune SQL: \`=\` mixes types (${key})`);
            }
            return left === right;
          };
        };
        const conjunction = (): Node => {
          const parts = [comparison()];
          while (peek()?.toUpperCase() === "AND") {
            take();
            parts.push(comparison());
          }
          return (row) => parts.every((part) => part(row));
        };
        function disjunction(): Node {
          const parts = [conjunction()];
          while (peek()?.toUpperCase() === "OR") {
            take();
            parts.push(conjunction());
          }
          return (row) => parts.some((part) => part(row));
        }
        const predicate = disjunction();
        if (position !== tokens.length) {
          throw new Error(`archive prune SQL: trailing ${tokens.slice(position).join(" ")}`);
        }
        return rows.filter((row) => !predicate(row)).map((row) => row.id);
      }

      async function pruneArchiveRows(rows: ArchiveFixture[]): Promise<string[]> {
        const archiveDb = mockArchiveDb();
        await pruneAuditArchive(archiveDb, now);
        const query = archiveDb.$executeRaw.mock.calls[0][0] as {
          strings: string[];
          values: unknown[];
        };
        return applyArchivePrune(query, rows);
      }

      // The parser is part of the proof, so it is tested too: an operator it
      // does not model must throw, never be read as one it does.
      it.each([
        ['"incidentPreserved" != false', /unsupported operator !=/],
        ['"incidentPreserved" <> false', /unsupported operator <>/],
        ['"createdAt" >= $0', /unsupported operator >=/],
        ['"createdAt" > $0', /unsupported operator >/],
        ['"createdAt" <= $0', /unsupported operator <=/],
        ['"createdAt" < $0;', /unrecognised text/],
        ['NOT "incidentPreserved" = false', /unsupported term NOT/],
      ])("the test's SQL parser refuses %s", (clause, error) => {
        // `$0` marks where a bound value goes, as in a Prisma.sql template.
        const [head, ...rest] = clause.split("$0");
        const query = {
          strings: [`DELETE FROM "AuditLogArchive" WHERE ${head}`, ...rest],
          values: rest.map(() => new Date("2019-05-10T00:00:00.000Z")),
        };
        expect(() =>
          applyArchivePrune(query, [
            { id: "row", createdAt: pastNormalRetention, incidentPreserved: false },
          ])
        ).toThrow(error);
      });

      it("the test's SQL parser compares dates by instant under =", () => {
        const sameInstant = new Date(pastNormalRetention.getTime());
        const query = {
          strings: ['DELETE FROM "AuditLogArchive" WHERE "createdAt" = ', ""],
          values: [sameInstant],
        };
        expect(
          applyArchivePrune(query, [
            { id: "row", createdAt: pastNormalRetention, incidentPreserved: false },
          ])
        ).toEqual([]);
      });

      it("keeps a preserved copy past seven years and prunes its unpreserved twin", async () => {
        // Drop the `"incidentPreserved" = false OR …` condition and the
        // preserved copy goes at seven years like its twin.
        const remaining = await pruneArchiveRows([
          { id: "preserved", createdAt: pastNormalRetention, incidentPreserved: true },
          { id: "unpreserved", createdAt: pastNormalRetention, incidentPreserved: false },
        ]);

        expect(remaining).toEqual(["preserved"]);
      });

      it("deletes a preserved copy just past ten years and keeps one just inside", async () => {
        // Drop the ten-year bound and the past-cap copy survives forever.
        const remaining = await pruneArchiveRows([
          { id: "preserved-past-cap", createdAt: justPastCap, incidentPreserved: true },
          { id: "preserved-inside-cap", createdAt: justInsideCap, incidentPreserved: true },
        ]);

        expect(remaining).toEqual(["preserved-inside-cap"]);
      });

      it("still prunes an unpreserved copy at the seven-year cutoff, not before", async () => {
        const sevenYearCutoff = new Date("2019-05-10T00:00:00.000Z");
        const remaining = await pruneArchiveRows([
          {
            id: "unpreserved-past-cutoff",
            createdAt: new Date(sevenYearCutoff.getTime() - 1),
            incidentPreserved: false,
          },
          { id: "unpreserved-at-cutoff", createdAt: sevenYearCutoff, incidentPreserved: false },
        ]);

        expect(remaining).toEqual(["unpreserved-at-cutoff"]);
      });
    });
  });
});
