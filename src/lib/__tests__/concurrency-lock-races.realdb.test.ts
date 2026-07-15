/**
 * Real-DB race regression harness for the two-tier lock protocol (#1881).
 *
 * These tests reproduce the concurrent interleavings the protocol exists to
 * defend against, against a REAL PostgreSQL. They are OFF by default and MUST be
 * a no-op in ordinary CI/local runs:
 *
 *   - They run ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`. With the flag unset the
 *     whole suite is `describe.skip`, so `npm test` never needs a live DB.
 *   - They read ONLY `CONCURRENCY_RACE_DATABASE_URL` and require a loopback host,
 *     explicit port 55442+, and a database name containing the dedicated
 *     `concurrency_race_1881` marker. Any mismatch aborts before Prisma imports.
 *
 * Run locally against a scratch database, e.g.:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts
 *
 * After validation, the dedicated URL is copied to DATABASE_URL solely for the
 * app's Prisma singleton/driver adapter used by this isolated test process.
 *
 * The harness validates the MECHANISM the whole fix rests on — advisory-lock
 * mutual exclusion plus status-guarded compare-and-set — against a scratch
 * table, plus a representative application-level settlement failure/re-point
 * race against the migrated Prisma schema. This keeps the mechanism probes
 * deterministic while proving an actual writer uses the protocol correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let prisma: typeof import("@/lib/prisma")["prisma"];
let markGroupSettlementIntentFailed: typeof import("@/lib/group-settlement")["markGroupSettlementIntentFailed"];

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated
 * env URL, loopback, an unusual high port, and the test-only database marker.
 */
export function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Concurrency race tests need a valid CONCURRENCY_RACE_DATABASE_URL."
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port)) {
    throw new Error(
      "Concurrency race DB URL must specify an explicit port (a throwaway instance at 55442+)."
    );
  }
  if (port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run concurrency race tests against port ${port}: use a throwaway Postgres on 55442+ (never the default 5432).`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Concurrency race DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Concurrency race DB name must contain the dedicated marker 'concurrency_race_1881'."
    );
  }
}

const PROBE_TABLE = "_concurrency_race_probe_1881";
const APP_MEMBER_ID = "race-1881-member";
const APP_LODGE_ID = "race-1881-lodge";
const APP_BOOKING_ID = "race-1881-booking";
const APP_GROUP_ID = "race-1881-group";
const APP_SETTLEMENT_ID = "race-1881-settlement";

describe("concurrency race DB safety guard (#1881)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeRaceDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881"
      )
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeRaceDbUrl(url)).toThrow();
  });
});

// Run only when explicitly enabled; otherwise this is a pure no-op.
(RUN ? describe : describe.skip)(
  "two-tier lock protocol — real-DB interleavings (#1881)",
  () => {
    beforeAll(async () => {
      // Never touch a default/production DB: the singleton connects via
      // dedicated URL, so guard THAT before importing Prisma or creating any
      // scratch state. Keeping the import behind the opt-in hook makes the
      // skipped suite a true no-op when the dedicated URL is absent.
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ markGroupSettlementIntentFailed } = await import("@/lib/group-settlement"));
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${PROBE_TABLE}" (id text PRIMARY KEY, status text NOT NULL)`
      );
      await prisma.member.create({
        data: {
          id: APP_MEMBER_ID,
          email: "race-1881@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Race",
          lastName: "Harness",
        },
      });
      await prisma.lodge.create({
        data: { id: APP_LODGE_ID, name: "Race Harness", slug: "race-1881" },
      });
      await prisma.booking.create({
        data: {
          id: APP_BOOKING_ID,
          memberId: APP_MEMBER_ID,
          lodgeId: APP_LODGE_ID,
          checkIn: new Date("2099-01-01"),
          checkOut: new Date("2099-01-02"),
          totalPriceCents: 100,
          finalPriceCents: 100,
        },
      });
      await prisma.groupBooking.create({
        data: {
          id: APP_GROUP_ID,
          organiserBookingId: APP_BOOKING_ID,
          organiserMemberId: APP_MEMBER_ID,
          joinCode: "RACE1881",
          paymentMode: "ORGANISER_PAYS",
        },
      });
      await prisma.groupBookingSettlement.create({
        data: {
          id: APP_SETTLEMENT_ID,
          groupBookingId: APP_GROUP_ID,
          stripePaymentIntentId: "pi_race_old",
          amountCents: 100,
        },
      });
    });

    afterAll(async () => {
      await prisma.groupBooking.deleteMany({ where: { id: APP_GROUP_ID } });
      await prisma.booking.deleteMany({ where: { id: APP_BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: APP_LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: APP_MEMBER_ID } });
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`);
      await prisma.$disconnect();
    });

    async function seedProbe(id: string, status: string) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${PROBE_TABLE}" (id, status) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        id,
        status
      );
    }

    async function readStatus(id: string): Promise<string> {
      const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "${PROBE_TABLE}" WHERE id = $1`,
        id
      );
      return rows[0]?.status ?? "";
    }

    /**
     * One "writer": take an advisory lock (transaction-scoped), then a
     * status-guarded compare-and-set from `fromStatus` to `toStatus`. Returns
     * the number of rows it claimed (1 = winner, 0 = lost the race).
     */
    async function guardedClaim(
      id: string,
      lockSql: string,
      fromStatus: string,
      toStatus: string
    ): Promise<number> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(lockSql);
        const res = await tx.$executeRawUnsafe(
          `UPDATE "${PROBE_TABLE}" SET status = $1 WHERE id = $2 AND status = $3`,
          toStatus,
          id,
          fromStatus
        );
        return typeof res === "number" ? res : 0;
      });
    }

    const GLOBAL_LOCK = "SELECT pg_advisory_xact_lock(1)";

    it("global lock(1) + status guard: exactly one of two concurrent claimers wins (cancel-vs-capture shape)", async () => {
      // Reproduces F1/F3/F2: two money/status writers race to flip the SAME row
      // out of PENDING (one to PAID, one to CANCELLED). Under lock(1) they
      // serialise, and the status-guarded update makes exactly one win.
      for (let i = 0; i < 25; i += 1) {
        const id = `race-global-${i}`;
        await seedProbe(id, "PENDING");
        const [a, b] = await Promise.all([
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "PAID"),
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "CANCELLED"),
        ]);
        // Exactly one writer claimed the row.
        expect(a + b).toBe(1);
        // The final state is whichever writer won — never a clobbered hybrid.
        expect(["PAID", "CANCELLED"]).toContain(await readStatus(id));
      }
    });

    it("status guard is the STRUCTURAL backstop even on mismatched keys (why the shared key matters)", async () => {
      // Reproduces the pre-#1881 defect shape: the two writers hold DIFFERENT
      // advisory keys (one global, one per-lodge), so they do NOT mutually
      // exclude. The status-guarded compare-and-set still yields exactly one
      // winner — proving the guard is the structural safety net beneath the
      // lock. (Without the guard, a bare UPDATE by id would let the loser
      // clobber the winner; see the next test.)
      const perLodgeLock =
        "SELECT pg_advisory_xact_lock(hashtextextended('lodge-x', 0))";
      for (let i = 0; i < 25; i += 1) {
        const id = `race-mismatched-${i}`;
        await seedProbe(id, "PENDING");
        const [a, b] = await Promise.all([
          guardedClaim(id, GLOBAL_LOCK, "PENDING", "PAID"),
          guardedClaim(id, perLodgeLock, "PENDING", "CANCELLED"),
        ]);
        expect(a + b).toBe(1);
        expect(["PAID", "CANCELLED"]).toContain(await readStatus(id));
      }
    });

    it("demonstrates that a BARE id-only update on mismatched keys CAN clobber (the bug the guard fixes)", async () => {
      // Documents the failure mode the status guard prevents: two bare updates
      // by id on different locks both "succeed", and the final state is simply
      // the last writer's — a cancelled booking resurrected to PAID, or vice
      // versa. This test asserts the clobber is POSSIBLE (both claim 1 row),
      // which is exactly why every status write in the cluster is guarded.
      const perLodgeLock =
        "SELECT pg_advisory_xact_lock(hashtextextended('lodge-y', 0))";
      async function bareClaim(id: string, lockSql: string, toStatus: string) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lockSql);
          const res = await tx.$executeRawUnsafe(
            `UPDATE "${PROBE_TABLE}" SET status = $1 WHERE id = $2`,
            toStatus,
            id
          );
          return typeof res === "number" ? res : 0;
        });
      }
      const id = "race-bare-clobber";
      await seedProbe(id, "PENDING");
      const [a, b] = await Promise.all([
        bareClaim(id, GLOBAL_LOCK, "PAID"),
        bareClaim(id, perLodgeLock, "CANCELLED"),
      ]);
      // Both bare updates matched the row by id (no status guard), so both
      // report a claim — the clobber the guarded pattern eliminates.
      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    it("application settlement failure cannot clobber an intent re-pointed under lock(1)", async () => {
      for (let i = 0; i < 20; i += 1) {
        const oldIntent = `pi_race_old_${i}`;
        const newIntent = `pi_race_new_${i}`;
        await prisma.groupBookingSettlement.update({
          where: { id: APP_SETTLEMENT_ID },
          data: { stripePaymentIntentId: oldIntent, status: "PENDING" },
        });

        await Promise.all([
          // Real application webhook writer.
          markGroupSettlementIntentFailed(oldIntent),
          // Representative settlement retry writer using the production lock
          // order and re-pointing the provider identity atomically.
          prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            await tx.groupBookingSettlement.update({
              where: { id: APP_SETTLEMENT_ID },
              data: { stripePaymentIntentId: newIntent, status: "PENDING" },
            });
          }),
        ]);

        const current = await prisma.groupBookingSettlement.findUniqueOrThrow({
          where: { id: APP_SETTLEMENT_ID },
          select: { stripePaymentIntentId: true, status: true },
        });
        expect(current).toEqual({
          stripePaymentIntentId: newIntent,
          status: "PENDING",
        });
      }
    });
  }
);
