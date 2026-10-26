/**
 * Real-PostgreSQL proof of closing a membership subscription charge as already
 * paid (#4098).
 *
 * `closeAlreadyPaidSubscriptionCharge` takes no advisory lock. It rests on two
 * guarded writes inside one transaction, and only a real server can show they
 * hold:
 *
 *   - the charge claim is a status-guarded `UPDATE`, so two closes at once (a
 *     double click, two officers) close the charge once: one audit row, and each
 *     subscription's `voidGeneration` bumped once, not twice;
 *   - the PAID re-check is the `WHERE` of the subscription write, so a manual
 *     reversal that commits while the close waits for the row makes the close
 *     roll back whole — the charge stays in CONFLICT with its claims active;
 *   - the invoice WORKER itself (#4098 review, F3 of the #4110 round): an
 *     attempt already in Xero when the charge is closed loses its recording
 *     write, and the same transaction leaves the stray marker on the closed
 *     charge, links nothing and emails nothing; a resume whose charge was
 *     voided meanwhile finishes as skipped.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4098-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/membership-subscription-charge-close.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

const MEMBER_IDS = ["race-4098-member-a", "race-4098-member-b"] as const;
const OFFICER_ID = "race-4098-officer";
const SUBSCRIPTION_IDS = ["race-4098-sub-a", "race-4098-sub-b"] as const;
const CHARGE_ID = "race-4098-charge";
const SEASON_YEAR = 2026;
const REASON = "Paid in cash at the AGM";
const CORRELATION_KEY = `membership-charge:${CHARGE_ID}:invoice-and-email:v1`;
const STALE_ATTEMPT_ID = "race-4098-op-stale";
const RETRY_ATTEMPT_ID = "race-4098-op-retry";
const STRAY_INVOICE_ID = "race-4098-stray-invoice";
const STRAY_INVOICE_NUMBER = "INV-RACE-4098";
const HELD_INVOICE_ID = "race-4098-held-invoice";

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Close-already-paid race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run close-already-paid race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Close-already-paid race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Close-already-paid race proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let closeAlreadyPaidSubscriptionCharge: (typeof import("@/lib/membership-subscription-charge-close"))["closeAlreadyPaidSubscriptionCharge"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

(RUN ? describe : describe.skip)(
  "a subscription charge closes as already paid exactly once — real PostgreSQL (#4098)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function deleteFixtures() {
      await prisma.auditLog.deleteMany({ where: { entityId: CHARGE_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { OR: [{ localId: CHARGE_ID }, { correlationKey: CORRELATION_KEY }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [CHARGE_ID, ...SUBSCRIPTION_IDS] } } });
      await prisma.membershipSubscriptionChargeComponent.deleteMany({ where: { chargeId: CHARGE_ID } });
      await prisma.membershipSubscriptionChargeCoverage.deleteMany({ where: { chargeId: CHARGE_ID } });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: CHARGE_ID } });
      await prisma.memberSubscription.deleteMany({ where: { id: { in: [...SUBSCRIPTION_IDS] } } });
      await prisma.member.deleteMany({ where: { id: { in: [...MEMBER_IDS, OFFICER_ID] } } });
    }

    async function seedFixtures() {
      for (const id of [...MEMBER_IDS, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Close",
            lastName: id.slice(-1).toUpperCase(),
            ageTier: "ADULT",
          },
        });
      }
      for (const [index, id] of SUBSCRIPTION_IDS.entries()) {
        await prisma.memberSubscription.create({
          data: {
            id,
            memberId: MEMBER_IDS[index],
            seasonYear: SEASON_YEAR,
            status: "PAID",
            manuallyMarkedPaidAt: new Date("2026-06-15T00:00:00.000Z"),
            manuallyMarkedPaidByMemberId: OFFICER_ID,
          },
        });
      }
      await prisma.membershipSubscriptionCharge.create({
        data: {
          id: CHARGE_ID,
          idempotencyKey: "race-4098-charge-key",
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: "CONFLICT",
          membershipTypeId: "race-4098-type",
          membershipTypeKey: "race-4098-type",
          membershipTypeName: "Race 4098",
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          annualAmountCents: 30_000,
          chargedAmountCents: 30_000,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          recipientMemberId: MEMBER_IDS[0],
          recipientName: "Close A",
          recipientEmail: `${MEMBER_IDS[0]}@example.invalid`,
          dueDays: 30,
          xeroAccountCode: "203",
          invoiceReference: "MEMSUB-RACE-4098",
          lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
          lastErrorMessage: "Covered subscriptions are already PAID (Close A, Close B); no Xero invoice was created.",
          coverage: {
            create: SUBSCRIPTION_IDS.map((subscriptionId, index) => ({
              subscriptionId,
              memberId: MEMBER_IDS[index],
              memberName: `Close ${index === 0 ? "A" : "B"}`,
            })),
          },
        },
      });
    }

    const close = () =>
      closeAlreadyPaidSubscriptionCharge({ chargeId: CHARGE_ID, reason: REASON, actorMemberId: OFFICER_ID });

    /**
     * Waits until `minimumBlocked` backends queue behind `blockerPid`, directly
     * or one step removed: a second writer on the same row waits on the tuple
     * lock the first waiter holds, so `pg_blocking_pids` names that waiter, not
     * the holder.
     */
    async function waitForBlockedBy(blockerPid: number, minimumBlocked = 1) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          WITH direct AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
          )
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database()
            AND (${blockerPid}::int = ANY(pg_blocking_pids(pid)) OR pg_blocking_pids(pid) && ARRAY(SELECT pid FROM direct))
        `;
        if ((rows[0]?.count ?? 0) >= minimumBlocked) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${minimumBlocked} backend(s) to queue behind the row lock held by pid ${blockerPid}.`);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ closeAlreadyPaidSubscriptionCharge } = await import("@/lib/membership-subscription-charge-close"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4098-reversal");
      observerClient = separate("race-4098-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
    });

    beforeEach(async () => {
      await deleteFixtures();
      await seedFixtures();
    });

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (prisma) await deleteFixtures();
    });

    it("closes once when two closes race: one audit row, every generation bumped once, the claims released", async () => {
      // Hold the charge row so both closes read it as CONFLICT and then queue on
      // their claim. On release one wins; the other's claim re-evaluates against
      // the committed close, matches nothing and takes the claim-lost path,
      // rather than the early already-closed return an unforced race usually hits.
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockedInHolder = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let holderPid = 0;
      const holder = lockHolderClient.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderPid = pid;
          await tx.$queryRaw`SELECT id FROM "MembershipSubscriptionCharge" WHERE id = ${CHARGE_ID} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 15_000 },
      );
      await lockedInHolder;

      const closing = Promise.all([close(), close()]);
      try {
        await waitForBlockedBy(holderPid, 2);
      } finally {
        release();
      }
      await holder;
      const outcomes = await closing;

      expect(outcomes.map((outcome) => outcome.closed).sort()).toEqual([false, true]);
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: CHARGE_ID } });
      expect(charge).toMatchObject({ status: "NOT_REQUIRED", lastErrorCode: null, lastErrorMessage: null, xeroInvoiceId: null });
      const subscriptions = await prisma.memberSubscription.findMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        select: { status: true, voidGeneration: true },
      });
      expect(subscriptions).toEqual([
        { status: "PAID", voidGeneration: 1 },
        { status: "PAID", voidGeneration: 1 },
      ]);
      expect(await prisma.membershipSubscriptionChargeCoverage.count({ where: { chargeId: CHARGE_ID, releasedAt: null } })).toBe(0);
      expect(await prisma.membershipSubscriptionChargeCoverage.count({ where: { chargeId: CHARGE_ID } })).toBe(2);
      const audits = await prisma.auditLog.findMany({ where: { entityId: CHARGE_ID } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "membership-subscription-billing.close-already-paid", memberId: OFFICER_ID });
      expect(JSON.parse(audits[0]!.details ?? "{}")).toMatchObject({ reason: REASON, subscriptionIds: [...SUBSCRIPTION_IDS] });
    });

    it("a worker's guarded write that waits on a close's uncommitted claim matches no row once the close commits (#4098 review, concurrency F3)", async () => {
      // Hold the close's transaction open AFTER its claim: the close claims the
      // charge row (CONFLICT -> NOT_REQUIRED, uncommitted) and then queues on a
      // subscription row this holder has locked. The invoice worker's recording
      // write — the real liveChargeWhere guard — then queues on the charge row
      // the close holds. Releasing lets the close commit, and PostgreSQL
      // re-evaluates the worker's WHERE against the committed NOT_REQUIRED row.
      const { liveChargeWhere } = await import("@/lib/subscription-charge-already-paid");
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockedInHolder = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let holderPid = 0;
      const holder = lockHolderClient.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderPid = pid;
          await tx.$queryRaw`SELECT id FROM "MemberSubscription" WHERE id = ${SUBSCRIPTION_IDS[1]} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 15_000 },
      );
      await lockedInHolder;

      const closing = close();
      await waitForBlockedBy(holderPid, 1);
      // `.then` sends it now: a Prisma query is lazy until awaited or chained.
      const workerWrite = prisma.membershipSubscriptionCharge.updateMany({
        where: liveChargeWhere(CHARGE_ID),
        data: { status: "INVOICE_CREATED", xeroInvoiceId: "race-4098-stray-invoice", xeroInvoiceNumber: "INV-STRAY" },
      }).then((result) => result);
      try {
        // The close behind the holder, and the worker behind the close.
        await waitForBlockedBy(holderPid, 2);
      } finally {
        release();
      }
      await holder;
      await expect(closing).resolves.toMatchObject({ closed: true });
      await expect(workerWrite).resolves.toEqual({ count: 0 });

      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: CHARGE_ID } });
      expect(charge).toMatchObject({ status: "NOT_REQUIRED", xeroInvoiceId: null });
    });

    /**
     * The invoice worker against a fake Xero (no provider call). `onCreateInvoice`
     * runs while the worker's createInvoices call is in flight, i.e. after the
     * worker read the charge and before it records the invoice; `onContact`
     * runs at the earlier contact lookup, which a resume also reaches.
     */
    async function withFakeXero<T>(
      hooks: { onCreateInvoice?: () => Promise<void>; onContact?: () => Promise<void> },
      run: (xero: { accountingApi: Record<string, ReturnType<typeof vi.fn>> }) => Promise<T>,
    ): Promise<T> {
      const xero = {
        accountingApi: {
          getInvoices: vi.fn(async () => ({ body: { invoices: [] } })),
          createInvoices: vi.fn(async () => {
            await hooks.onCreateInvoice?.();
            return { body: { invoices: [{ invoiceID: STRAY_INVOICE_ID, invoiceNumber: STRAY_INVOICE_NUMBER }] } };
          }),
          emailInvoice: vi.fn(async () => ({ body: {} })),
        },
      };
      const [apiClient, contacts] = await Promise.all([import("@/lib/xero-api-client"), import("@/lib/xero-contacts")]);
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4098" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(contacts, "findOrCreateXeroContact").mockImplementation((async () => {
          await hooks.onContact?.();
          return "contact-4098";
        }) as never),
      ];
      try {
        return await run(xero);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** An outbox attempt for the charge, as the outbox claim leaves it. */
    async function invoiceAttempt(id: string, status: "RUNNING" | "PENDING", startedAt: Date | null) {
      await prisma.xeroSyncOperation.create({
        data: {
          id,
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "MembershipSubscriptionCharge",
          localId: CHARGE_ID,
          status,
          idempotencyKey: CORRELATION_KEY,
          correlationKey: CORRELATION_KEY,
          queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE",
          requestPayload: { queueType: "MEMBERSHIP_SUBSCRIPTION_INVOICE" },
          startedAt,
        },
      });
    }

    /**
     * Records, per statement, every UPDATE on this charge's row — including a
     * guarded UPDATE that matched nothing — with its transaction id, so a test
     * can show which writes shared a transaction. A statement-level trigger
     * fires for zero rows; its transition table says what (if anything) changed.
     */
    async function recordChargeUpdates(run: () => Promise<unknown>) {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS race_4098_charge_updates (seq serial PRIMARY KEY, tx bigint, row_count int, error_code text)`);
      await prisma.$executeRawUnsafe(`TRUNCATE race_4098_charge_updates`);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION race_4098_record_charge_update() RETURNS trigger AS $$
        BEGIN
          INSERT INTO race_4098_charge_updates (tx, row_count, error_code)
          SELECT txid_current(), COUNT(*)::int, MAX("lastErrorCode") FROM changed WHERE "id" = '${CHARGE_ID}';
          RETURN NULL;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4098_charge_update_trigger ON "MembershipSubscriptionCharge"`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER race_4098_charge_update_trigger AFTER UPDATE ON "MembershipSubscriptionCharge" REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION race_4098_record_charge_update()`,
      );
      try {
        await run();
        return await prisma.$queryRawUnsafe<Array<{ tx: bigint; row_count: number; error_code: string | null }>>(
          `SELECT tx, row_count, error_code FROM race_4098_charge_updates ORDER BY seq`,
        );
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4098_charge_update_trigger ON "MembershipSubscriptionCharge"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4098_record_charge_update()`);
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS race_4098_charge_updates`);
      }
    }

    it("an invoice attempt in Xero when the charge is closed loses its claim, and that transaction marks the stray (#4098 review, F3 of the #4110 round)", async () => {
      const { createXeroMembershipSubscriptionInvoice } = await import("@/lib/xero-subscription-invoices");
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      const { STRAY_INVOICE_AFTER_CLOSE_CODE } = await import("@/lib/subscription-charge-already-paid");
      // The charge is queued and nobody has paid yet, so the worker goes to Xero.
      await prisma.membershipSubscriptionCharge.update({
        where: { id: CHARGE_ID },
        data: {
          status: "QUEUED", lastErrorCode: null, lastErrorMessage: null,
          components: { create: [{ label: "Family fee", description: "Race 4098 family fee", annualAmountCents: 30_000, chargedAmountCents: 30_000, prorated: false, xeroAccountCode: "203", sortOrder: 0 }] },
        },
      });
      await prisma.memberSubscription.updateMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        data: { status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      // Claimed long enough ago that the stale-RUNNING reset may fail it.
      await invoiceAttempt(STALE_ATTEMPT_ID, "RUNNING", new Date("2026-06-30T00:00:00.000Z"));

      // While its Xero call hangs: the stale-RUNNING reset fails the attempt;
      // the members pay by hand; a Retry's attempt finds them paid and parks the
      // charge in CONFLICT (the real worker, which makes no Xero call); and the
      // officer closes it — no invoice operation is live any more, so the
      // close's own refusal does not fire.
      const onCreateInvoice = async () => {
        await expect(
          markStaleRunningXeroOperationFailed(STALE_ATTEMPT_ID, async () => {}, new Date("2026-07-01T00:00:00.000Z")),
        ).resolves.toMatchObject({ outcome: "marked" });
        await prisma.memberSubscription.updateMany({
          where: { id: { in: [...SUBSCRIPTION_IDS] } },
          data: { status: "PAID", manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00.000Z"), manuallyMarkedPaidByMemberId: OFFICER_ID },
        });
        await invoiceAttempt(RETRY_ATTEMPT_ID, "RUNNING", new Date("2026-07-01T00:00:00.000Z"));
        await expect(
          createXeroMembershipSubscriptionInvoice({ chargeId: CHARGE_ID, syncOperationId: RETRY_ATTEMPT_ID }),
        ).resolves.toBeNull();
        await expect(close()).resolves.toMatchObject({ closed: true });
      };

      let xeroCalls!: { accountingApi: Record<string, ReturnType<typeof vi.fn>> };
      let outcome: unknown;
      const updates = await recordChargeUpdates(() =>
        withFakeXero({ onCreateInvoice }, async (xero) => {
          xeroCalls = xero;
          outcome = await createXeroMembershipSubscriptionInvoice({ chargeId: CHARGE_ID, syncOperationId: STALE_ATTEMPT_ID });
        }),
      );

      expect(outcome).toBeNull();
      // The worker began on the fresh-raise path (`!charge.xeroInvoiceId`): it
      // raised one invoice and never emailed it.
      expect(xeroCalls.accountingApi.createInvoices).toHaveBeenCalledTimes(1);
      expect(xeroCalls.accountingApi.emailInvoice).not.toHaveBeenCalled();
      // The closed charge stays closed and unlinked, and names the stray.
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: CHARGE_ID } });
      expect(charge).toMatchObject({ status: "NOT_REQUIRED", xeroInvoiceId: null, xeroInvoiceNumber: null, lastErrorCode: STRAY_INVOICE_AFTER_CLOSE_CODE });
      expect(charge.lastErrorMessage).toContain(STRAY_INVOICE_NUMBER);
      // In the losing transaction: the worker's guarded claim matched no row,
      // and the stray marker is the next write in that same transaction.
      const markerAt = updates.findIndex((row) => row.error_code === STRAY_INVOICE_AFTER_CLOSE_CODE);
      expect(markerAt).toBeGreaterThan(0);
      expect(updates[markerAt]).toMatchObject({ row_count: 1 });
      expect(updates[markerAt - 1]).toMatchObject({ row_count: 0, tx: updates[markerAt]!.tx });
      // Nothing else of the invoice was recorded: no subscription link or
      // downgrade, and no object link for the charge or its subscriptions.
      const subscriptions = await prisma.memberSubscription.findMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        select: { status: true, xeroInvoiceId: true },
      });
      expect(subscriptions).toEqual([{ status: "PAID", xeroInvoiceId: null }, { status: "PAID", xeroInvoiceId: null }]);
      expect(await prisma.xeroObjectLink.count({ where: { localId: { in: [CHARGE_ID, ...SUBSCRIPTION_IDS] } } })).toBe(0);
      // The attempt's own outcome is the stray, for Xero Operations.
      const attempt = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: STALE_ATTEMPT_ID } });
      expect(attempt).toMatchObject({ status: "PARTIAL", xeroObjectId: STRAY_INVOICE_ID });
      expect(attempt.responsePayload).toMatchObject({ conflict: STRAY_INVOICE_AFTER_CLOSE_CODE });
    });

    it("a resume whose charge was voided while it was in Xero finishes as skipped and marks no stray (#4098 review, F3 of the #4110 round)", async () => {
      const { createXeroMembershipSubscriptionInvoice } = await import("@/lib/xero-subscription-invoices");
      // The invoice was raised on an earlier attempt and its email failed; this
      // attempt resumes from the held invoice id.
      await prisma.membershipSubscriptionCharge.update({
        where: { id: CHARGE_ID },
        data: {
          status: "EMAIL_FAILED", lastErrorCode: "EMAIL_FAILED", lastErrorMessage: "Xero email failed",
          xeroInvoiceId: HELD_INVOICE_ID, xeroInvoiceNumber: "INV-HELD",
          components: { create: [{ label: "Family fee", description: "Race 4098 family fee", annualAmountCents: 30_000, chargedAmountCents: 30_000, prorated: false, xeroAccountCode: "203", sortOrder: 0 }] },
        },
      });
      await prisma.memberSubscription.updateMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        data: { status: "UNPAID", xeroInvoiceId: HELD_INVOICE_ID, manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await invoiceAttempt(RETRY_ATTEMPT_ID, "RUNNING", new Date("2026-07-01T00:00:00.000Z"));

      // While the resume is at Xero, the membership sync sees the invoice
      // VOIDED and releases it, once per covered member, through its own
      // release (#4110 review F8: the real writer, not a copy of its writes).
      const { releaseVoidedSubscriptionInvoice } = await import("@/lib/xero-membership-sync");
      const onContact = async () => {
        for (const [index, subscriptionId] of SUBSCRIPTION_IDS.entries()) {
          await releaseVoidedSubscriptionInvoice({
            subscriptionId,
            memberId: MEMBER_IDS[index]!,
            seasonYear: SEASON_YEAR,
            voidedInvoiceId: HELD_INVOICE_ID,
          });
        }
      };

      let xeroCalls!: { accountingApi: Record<string, ReturnType<typeof vi.fn>> };
      const outcome = await withFakeXero({ onContact }, async (xero) => {
        xeroCalls = xero;
        return createXeroMembershipSubscriptionInvoice({ chargeId: CHARGE_ID, syncOperationId: RETRY_ATTEMPT_ID });
      });

      expect(outcome).toBeNull();
      expect(xeroCalls.accountingApi.createInvoices).not.toHaveBeenCalled();
      expect(xeroCalls.accountingApi.emailInvoice).not.toHaveBeenCalled();
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: CHARGE_ID } });
      // VOIDED, no stray marker: this attempt raised nothing new.
      expect(charge).toMatchObject({ status: "VOIDED", lastErrorCode: null });
      const attempt = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: RETRY_ATTEMPT_ID } });
      expect(attempt.status).toBe("SUCCEEDED");
      expect(attempt.responsePayload).toEqual({ skipped: true, reason: "VOIDED" });
      // The void's release stands: nothing relinked the members.
      const subscriptions = await prisma.memberSubscription.findMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        select: { status: true, xeroInvoiceId: true },
      });
      expect(subscriptions).toEqual([{ status: "NOT_INVOICED", xeroInvoiceId: null }, { status: "NOT_INVOICED", xeroInvoiceId: null }]);
    });

    it("rolls back whole when a reversal commits while the close waits for the subscription row", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reversed!: () => void;
      const reversedInHolder = new Promise<void>((resolve) => {
        reversed = resolve;
      });
      let holderPid = 0;
      // The manual reversal's status-fenced write: it holds the row until released.
      const reversal = lockHolderClient.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderPid = pid;
          await tx.memberSubscription.updateMany({
            where: { id: SUBSCRIPTION_IDS[1], status: "PAID", manuallyMarkedPaidAt: { not: null } },
            data: { status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
          });
          reversed();
          await released;
        },
        { timeout: 15_000 },
      );
      await reversedInHolder;

      const closing = close();
      await waitForBlockedBy(holderPid);
      release();
      await reversal;

      await expect(closing).rejects.toMatchObject({ status: 409, message: expect.stringContaining("stopped being paid while you were closing this charge") });
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: CHARGE_ID } });
      expect(charge).toMatchObject({ status: "CONFLICT", lastErrorCode: "SUBSCRIPTION_ALREADY_PAID" });
      const subscriptions = await prisma.memberSubscription.findMany({
        where: { id: { in: [...SUBSCRIPTION_IDS] } },
        orderBy: { id: "asc" },
        select: { status: true, voidGeneration: true },
      });
      expect(subscriptions).toEqual([
        { status: "PAID", voidGeneration: 0 },
        { status: "NOT_INVOICED", voidGeneration: 0 },
      ]);
      expect(await prisma.membershipSubscriptionChargeCoverage.count({ where: { chargeId: CHARGE_ID, releasedAt: null } })).toBe(2);
      expect(await prisma.auditLog.count({ where: { entityId: CHARGE_ID } })).toBe(0);
    });
  },
);
