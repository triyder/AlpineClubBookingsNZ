/**
 * Real-PostgreSQL proof of #4250 (`INV-INT-025`): a refund-note create an
 * officer resolved by hand in Xero stops counting as coverage once a link
 * records its note VOIDED or DELETED.
 *
 * The issue's example: a $250 card refund raises note N1; its create row ends
 * PARTIAL and an officer marks it resolved in Xero; later N1 is voided, and
 * its link goes inactive with the void recorded. Before the fix the resolved
 * row's $250 came back as coverage, so the nightly card self-heal saw no gap
 * and raised no note. Here:
 *
 * - the shared reader (`readResolvedRefundCreditNoteCoverage`) and the
 *   payment-wide sum count 0 for that row, while a resolved row whose note is
 *   live (an active link) or unlinked still covers the refund, once;
 * - its id is still reported but never its key (review, money P2), and an
 *   unreadable amount on it no longer refuses anything;
 * - the self-heal's list (`getRefundsMissingXeroCreditNotes`) shows the $250
 *   gap, and the enqueue the cron makes from it (`reconcileCreditBalances`'s
 *   card ask) queues a fresh card note under an after-void key naming N1 -
 *   or, when N1 executed at another watermark than it was queued at, under
 *   N1's own row's key, which no fence then refuses.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4250-`
 * fixtures. No Stripe or Xero call is made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4250";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const INTENT_ID = "pi_race_4250";
const NOTE_ID = `${P}-note-n1`;
const ROW_ID = `${P}-n1-create`;
const PAID_CENTS = 40_000;
const REFUND_CENTS = 25_000;
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
/** Past every payment's 24-hour grace: the self-heal's list as a later night reads it. */
const LATER_NIGHT = new Date("2100-01-01T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Resolved-then-voided refund note proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run resolved-then-voided refund note proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Resolved-then-voided refund note proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Resolved-then-voided refund note proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let fences: typeof import("@/lib/xero-resolved-in-xero-fences");
let n1Key: string;

(RUN ? describe : describe.skip)(
  "a refund note resolved by hand in Xero and later voided covers nothing - real PostgreSQL (#4250)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A card payment, invoiced in Xero, with one $250 refund Stripe confirmed. */
    async function refundedCardPayment() {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, refundedAmountCents: REFUND_CENTS, source: "STRIPE",
          status: "PARTIALLY_REFUNDED", stripePaymentIntentId: INTENT_ID, xeroInvoiceId: `inv-${P}`,
          transactions: {
            create: {
              id: TXN_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT_ID, amountCents: PAID_CENTS,
              refundedAmountCents: REFUND_CENTS, status: "PARTIALLY_REFUNDED",
            },
          },
        },
      });
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, stripeRefundId: `re_${P}`, stripePaymentIntentId: INTENT_ID,
          amountCents: REFUND_CENTS, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
    }

    /**
     * N1's create row: PARTIAL (the note was made, its refund payment failed),
     * then resolved by an officer in Xero. `payload: "unreadable"` writes a
     * payload no reader can size.
     */
    async function resolvedN1Row(payload: "readable" | "unreadable" = "readable") {
      await prisma.xeroSyncOperation.create({
        data: {
          id: ROW_ID, direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "PARTIAL", queueType: "REFUND_CREDIT_NOTE", correlationKey: n1Key, idempotencyKey: n1Key, xeroObjectId: NOTE_ID,
          requestPayload:
            payload === "readable"
              ? { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: REFUND_CENTS, watermarkCents: REFUND_CENTS }
              : { queueType: "REFUND_CREDIT_NOTE" },
          manuallyResolvedAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      });
    }

    /** N1's refund-note link: live, or as an inbound void leaves it (#4091) - inactive, its status recorded. */
    async function n1Link(state: "live" | "VOIDED" | "DELETED", executedWatermarkCents = REFUND_CENTS) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "REFUND_CREDIT_NOTE",
          active: state === "live",
          metadata: { amountCents: REFUND_CENTS, watermarkCents: executedWatermarkCents, status: state === "live" ? "AUTHORISED" : state },
        },
      });
    }

    async function coverage() {
      const resolved = await fences.readResolvedRefundCreditNoteCoverage(PAYMENT_ID);
      return { resolved, totalCents: await fences.sumRefundCreditNoteCoverageCents(PAYMENT_ID, resolved) };
    }

    async function selfHealRow() {
      const { getRefundsMissingXeroCreditNotes } = await import("@/lib/xero-admin-health");
      return (await getRefundsMissingXeroCreditNotes({ now: LATER_NIGHT })).payments.find((row) => row.paymentId === PAYMENT_ID) ?? null;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      fences = await import("@/lib/xero-resolved-in-xero-fences");
      const { buildXeroIdempotencyKey } = await import("@/lib/xero-sync");
      n1Key = buildXeroIdempotencyKey("payment", PAYMENT_ID, "refund-credit-note", REFUND_CENTS, "v2");

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Cover", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4250 Lodge", slug: P } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
      await refundedCardPayment();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("a resolved row whose note has a live link covers the refund once, through the link", async () => {
      await resolvedN1Row();
      await n1Link("live");

      const { resolved, totalCents } = await coverage();
      expect(resolved.coveredCents).toBe(0);
      expect(totalCents).toBe(REFUND_CENTS);
      expect(await selfHealRow()).toBeNull();
    });

    it("a resolved row whose note has no link covers its recorded amount (the officer's hand-made note)", async () => {
      await resolvedN1Row();

      const { resolved, totalCents } = await coverage();
      expect(resolved.coveredCents).toBe(REFUND_CENTS);
      expect(totalCents).toBe(REFUND_CENTS);
      expect(await selfHealRow()).toBeNull();
    });

    it.each(["VOIDED", "DELETED"] as const)("MUTATION: a resolved row whose note Xero %s covers nothing; its id is still reported, never its key", async (status) => {
      await resolvedN1Row();
      await n1Link(status);

      const { resolved, totalCents } = await coverage();
      expect(resolved.coveredCents).toBe(0);
      expect(totalCents).toBe(0);
      expect(resolved.operationIds).toEqual([ROW_ID]);
      expect(resolved.correlationKeys).toEqual([]);
      expect(resolved.unreadableOperationIds).toEqual([]);
      // One refund's own rows, asked the same way (`sumRefundCreditNoteCoverageOfRowsCents`).
      expect(await fences.sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, { id: ROW_ID })).toBe(0);
    });

    it("a resolved row whose note Xero voided refuses nothing, even when its amount cannot be read", async () => {
      await resolvedN1Row("unreadable");
      await n1Link("VOIDED");

      const { resolved } = await coverage();
      expect(resolved.unreadableOperationIds).toEqual([]);
      expect(resolved.coveredCents).toBe(0);
      expect(resolved.operationIds).toEqual([ROW_ID]);
    });

    it("the issue's example: the nightly card self-heal lists the $250 gap and queues a fresh card note under an after-void key", async () => {
      await resolvedN1Row();
      await n1Link("VOIDED");

      const row = await selfHealRow();
      expect(row).toMatchObject({ cashRefundedCents: REFUND_CENTS, uncoveredCents: REFUND_CENTS, paidAnotherWayUncoveredCents: 0 });

      // The card ask `reconcileCreditBalances` queues from that row.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, row!.uncoveredCents - row!.paidAnotherWayUncoveredCents);
      expect(queued.queueOperationId).toEqual(expect.any(String));
      expect(queued).not.toHaveProperty("resolvedInXeroOperationId");

      const fresh = await prisma.xeroSyncOperation.findUniqueOrThrow({
        where: { id: queued.queueOperationId! },
        select: { status: true, correlationKey: true, requestPayload: true, xeroObjectId: true },
      });
      expect(fresh.status).toBe("PENDING");
      expect(fresh.xeroObjectId).toBeNull();
      expect(fresh.requestPayload).toMatchObject({ queueType: "REFUND_CREDIT_NOTE", refundAmountCents: REFUND_CENTS, watermarkCents: REFUND_CENTS });
      // `INV-ADDPAY-041`: never N1's own key, so N1 is never re-adopted.
      const { buildXeroIdempotencyKey } = await import("@/lib/xero-sync");
      expect(fresh.correlationKey).not.toBe(n1Key);
      expect(fresh.correlationKey).toBe(buildXeroIdempotencyKey("payment", PAYMENT_ID, "refund-credit-note", REFUND_CENTS, "v2", "after-void", NOTE_ID));

      // A second night's replay is the same queued row, not a second note.
      const replay = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, REFUND_CENTS);
      expect(replay.queueOperationId).toBe(queued.queueOperationId);
    });

    it("MUTATION (review, money P2): the voided note executed at another watermark than it was queued at - the re-raise takes its old key and is still queued", async () => {
      // Queued at $250 (its key), executed at $200 (its link): the after-void
      // suffix names a note whose recorded watermark equals the re-raise's, so
      // here it names none and the re-raise's key is N1's own row's.
      await resolvedN1Row();
      await n1Link("VOIDED", 20_000);

      const row = await selfHealRow();
      expect(row).toMatchObject({ uncoveredCents: REFUND_CENTS });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, REFUND_CENTS);
      expect(queued).not.toHaveProperty("resolvedInXeroOperationId");
      expect(queued.queueOperationId).toEqual(expect.any(String));
      expect(queued.queueOperationId).not.toBe(ROW_ID);
      const fresh = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: queued.queueOperationId! }, select: { status: true, correlationKey: true } });
      expect(fresh).toEqual({ status: "PENDING", correlationKey: n1Key });
    });

    it("a voided note's resolved row with an unreadable amount: the self-heal still lists the gap and queues the re-raise", async () => {
      await resolvedN1Row("unreadable");
      await n1Link("VOIDED");

      expect(await selfHealRow()).toMatchObject({ uncoveredCents: REFUND_CENTS });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, REFUND_CENTS);
      expect(queued).not.toHaveProperty("resolvedInXeroOperationId");
      expect(queued.queueOperationId).toEqual(expect.any(String));
    });
  },
);
