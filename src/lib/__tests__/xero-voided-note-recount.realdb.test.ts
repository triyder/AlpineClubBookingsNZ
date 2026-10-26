/**
 * Real-PostgreSQL proof of #4291: a refund credit note Xero voided still
 * resolves to the payment whose mirror the void turned off, so a later inbound
 * event for that note - a redelivery, the retry of an event that failed after
 * its link write, or an operator's replay - recounts the payment's refunded
 * total (`repairRefundedPaymentBusinessState`).
 *
 * The void's link write turns the mirror off and releases the payment's
 * pointer in one transaction (#4046, #4091), before the recount runs. Before
 * the fix the reconcile found a note's payments only through an active link or
 * the pointer, so once that write had committed nothing named the payment: an
 * event that died before its recount could never be finished by its retry.
 *
 * The mirror stays inactive and the pointer is never written back
 * (`INV-ADDPAY-041`); only a mirror recorded VOIDED or DELETED resolves, and
 * only for an event that reads the note cancelled.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4291-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4291";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const PAID_CENTS = 20_000;
const VOIDED_NOTE = `${P}-cn-voided`;
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a voided refund note's later inbound events still recount its payment - real PostgreSQL (#4291)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.auditLog.deleteMany({ where: { metadata: { path: ["creditNoteId"], string_starts_with: P } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * A bank-transfer payment whose refunded total Xero recorded: `refundedCents`
     * on the payment, none of it in the transaction detail (so the #4162 floor
     * lets the recount follow Xero down), and its refund notes' mirrors.
     */
    async function bankTransferPayment(
      refundedCents: number,
      pointer: string | null,
      notes: Array<{ id: string; active: boolean; metadata: Record<string, unknown> }>,
    ) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "INTERNET_BANKING",
          status: refundedCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED", refundedAmountCents: refundedCents,
          xeroInvoiceId: `inv-${P}`, xeroRefundCreditNoteId: pointer,
        },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAID_CENTS, status: "SUCCEEDED", xeroInvoiceId: `inv-${P}` },
      });
      for (const note of notes) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.id,
            xeroObjectNumber: `CN-${note.id}`, role: "REFUND_CREDIT_NOTE", active: note.active, metadata: note.metadata as never,
          },
        });
      }
    }

    function xeroNote(noteId: string, status: "VOIDED" | "AUTHORISED", cents: number) {
      return { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status, total: cents / 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] };
    }

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function inbound(note: ReturnType<typeof xeroNote>) {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4291" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        return await reconcileXeroCreditNote(note.creditNoteID);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The audit rows naming the payment for a recount reached only through its voided mirror (#4291). */
    function voidedMirrorRecountAudits() {
      return prisma.auditLog.findMany({
        where: {
          entityType: "Payment",
          entityId: PAYMENT_ID,
          AND: [
            { metadata: { path: ["source"], equals: "xero-inbound-credit-note-voided-mirror-recount" } },
            { metadata: { path: ["creditNoteId"], equals: VOIDED_NOTE } },
          ],
        },
        select: { action: true, category: true, metadata: true },
      });
    }

    async function state() {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { refundedAmountCents: true, status: true, xeroRefundCreditNoteId: true },
      });
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        select: { xeroObjectId: true, active: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return { ...payment, links };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Voided refund note recount (#4291)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Recount", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4291 Lodge", slug: P } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CANCELLED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
      vi.restoreAllMocks();
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await deleteFixtures();
    }, 60_000);

    it("MUTATION (resolve): the void's event dies after its link write; its retry recounts the payment, and the mirror stays off", async () => {
      await bankTransferPayment(15_000, VOIDED_NOTE, [
        { id: VOIDED_NOTE, active: true, metadata: { amountCents: 15_000, watermarkCents: 15_000, status: "AUTHORISED", total: 150 } },
      ]);

      // The recount's claim fails: the link write before it has committed.
      const updateMany = prisma.payment.updateMany.bind(prisma.payment);
      const claim = vi.spyOn(prisma.payment, "updateMany").mockImplementation((async (args: { where?: { updatedAt?: unknown } }) => {
        if (args.where?.updatedAt !== undefined) throw new Error("connection lost before the recount wrote");
        return updateMany(args as never);
      }) as never);
      // #4288: a payment holding the note's own refund-note row is claimed in a
      // transaction of its own under its row lock; that claim fails the same way.
      const { interceptTransactionPaymentClaims } = await import("./support/transaction-payment-claims");
      const lockedClaim = interceptTransactionPaymentClaims(prisma, async () => {
        throw new Error("connection lost before the recount wrote");
      });
      await expect(inbound(xeroNote(VOIDED_NOTE, "VOIDED", 15_000))).rejects.toThrow("connection lost");
      claim.mockRestore();
      lockedClaim.mockRestore();

      // The mirror is off and the pointer released; Xero no longer records the
      // refund, but the total still does.
      expect(await state()).toEqual({
        refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED", xeroRefundCreditNoteId: null,
        links: [{ xeroObjectId: VOIDED_NOTE, active: false }],
      });

      expect(await voidedMirrorRecountAudits()).toEqual([]);

      // The retry of the same event. Before the fix it matched no payment and
      // left the total at 15_000 for good.
      const retried = await inbound(xeroNote(VOIDED_NOTE, "VOIDED", 15_000));

      expect(retried).toMatchObject({ matchedRefundedPayments: 1, updatedRefundedPayments: 1 });
      expect(await state()).toEqual({
        refundedAmountCents: 0, status: "SUCCEEDED", xeroRefundCreditNoteId: null,
        links: [{ xeroObjectId: VOIDED_NOTE, active: false }],
      });
      // MUTATION (audit): the recount that changed the total names the payment.
      expect(await voidedMirrorRecountAudits()).toEqual([
        expect.objectContaining({
          action: "xero.credit_note.reconciled",
          category: "xero",
          metadata: expect.objectContaining({
            localModel: "Payment", localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: VOIDED_NOTE, xeroObjectNumber: `CN-${VOIDED_NOTE}`, bookingId: BOOKING_ID, updatedRefundedPayments: 1,
          }),
        }),
      ]);

      // A later replay recounts again and changes nothing: never re-adopted.
      const replayed = await inbound(xeroNote(VOIDED_NOTE, "VOIDED", 15_000));
      expect(replayed).toMatchObject({ matchedRefundedPayments: 1, updatedRefundedPayments: 0, matchedPayments: 0, updatedPayments: 0 });
      expect(await state()).toEqual({
        refundedAmountCents: 0, status: "SUCCEEDED", xeroRefundCreditNoteId: null,
        links: [{ xeroObjectId: VOIDED_NOTE, active: false }],
      });
      expect(await voidedMirrorRecountAudits()).toHaveLength(2);
    });

    it("MUTATION (read after the link writes): a second event whose reads straddle a concurrent void's link write still recounts the payment", async () => {
      await bankTransferPayment(15_000, VOIDED_NOTE, [
        { id: VOIDED_NOTE, active: true, metadata: { amountCents: 15_000, watermarkCents: 15_000, status: "AUTHORISED", total: 150 } },
      ]);
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const realLinkFindMany = prisma.xeroObjectLink.findMany.bind(prisma.xeroObjectLink);
      const realPaymentFindMany = prisma.payment.findMany.bind(prisma.payment);
      let armed = true;
      let lookup: Promise<unknown> | null = null;
      let firstVoidCommitted!: () => void;
      const firstVoidCommittedP = new Promise<void>((resolve) => (firstVoidCommitted = resolve));
      type Where = { where?: Record<string, unknown> };
      vi.spyOn(prisma.xeroObjectLink, "findMany").mockImplementation(((args: Where) => {
        const where = args?.where ?? {};
        if (armed && where.xeroObjectId === VOIDED_NOTE && where.role === "REFUND_CREDIT_NOTE" && where.active === false) {
          lookup = realLinkFindMany(args as never);
          return lookup;
        }
        if (armed && where.xeroObjectId === VOIDED_NOTE && where.active === true && where.localModel === undefined) {
          return (async () => {
            // A voided-mirror lookup already issued beside this read (the
            // pre-fix shape) answers first, from the state before the void.
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (lookup) await lookup;
            // A concurrent event's void link write commits now: before this
            // event's active-link read, after its lookup (if it made one).
            await upsertXeroObjectLink({
              localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: VOIDED_NOTE,
              xeroObjectNumber: `CN-${VOIDED_NOTE}`, role: "REFUND_CREDIT_NOTE",
              metadata: { status: "VOIDED", total: 150, appliedAmount: 0, remainingCredit: 0 }, mergeMetadata: true,
            });
            firstVoidCommitted();
            return realLinkFindMany(args as never);
          })();
        }
        return realLinkFindMany(args as never);
      }) as never);
      vi.spyOn(prisma.payment, "findMany").mockImplementation((async (args: Where) => {
        // The pointer read lands after the void released the pointer.
        if (armed && args?.where?.xeroRefundCreditNoteId === VOIDED_NOTE && !args?.where?.OR) await firstVoidCommittedP;
        return realPaymentFindMany(args as never);
      }) as never);

      const second = await inbound(xeroNote(VOIDED_NOTE, "VOIDED", 15_000));
      armed = false;

      // Neither the active link nor the pointer named the payment; the lookup
      // made after this event's link writes did.
      expect(second).toMatchObject({ matchedPayments: 0, matchedRefundedPayments: 1, updatedRefundedPayments: 1 });
      expect(await state()).toEqual({
        refundedAmountCents: 0, status: "SUCCEEDED", xeroRefundCreditNoteId: null,
        links: [{ xeroObjectId: VOIDED_NOTE, active: false }],
      });
      expect(await voidedMirrorRecountAudits()).toHaveLength(1);
    });

    it("MUTATION (recorded void): a superseded note's mirror, off but never recorded voided, does not resolve when Xero voids it", async () => {
      const LIVE_NOTE = `${P}-cn-live`;
      // An older canonical note the single-note rule retired: inactive, recorded live.
      await bankTransferPayment(15_000, LIVE_NOTE, [
        { id: LIVE_NOTE, active: true, metadata: { amountCents: 5_000, watermarkCents: 5_000, status: "AUTHORISED", total: 50 } },
        { id: VOIDED_NOTE, active: false, metadata: { amountCents: 15_000, watermarkCents: 15_000, status: "AUTHORISED", total: 150 } },
      ]);

      const result = await inbound(xeroNote(VOIDED_NOTE, "VOIDED", 15_000));

      expect(result).toMatchObject({ matchedPayments: 0, matchedRefundedPayments: 0, updatedRefundedPayments: 0 });
      expect(await state()).toEqual({
        refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED", xeroRefundCreditNoteId: LIVE_NOTE,
        links: [{ xeroObjectId: LIVE_NOTE, active: true }, { xeroObjectId: VOIDED_NOTE, active: false }],
      });
    });

    it("MUTATION (cancelled read): a read of the note as live never resolves its voided mirror, so the voided note is never counted again", async () => {
      await bankTransferPayment(0, null, [
        { id: VOIDED_NOTE, active: false, metadata: { amountCents: 15_000, watermarkCents: 15_000, status: "VOIDED", total: 150 } },
      ]);

      const result = await inbound(xeroNote(VOIDED_NOTE, "AUTHORISED", 15_000));

      expect(result).toMatchObject({ matchedPayments: 0, matchedRefundedPayments: 0, updatedRefundedPayments: 0 });
      expect(await state()).toEqual({
        refundedAmountCents: 0, status: "SUCCEEDED", xeroRefundCreditNoteId: null,
        links: [{ xeroObjectId: VOIDED_NOTE, active: false }],
      });
    });
  },
);
