/**
 * #4250 (`INV-INT-025`): what a refund-note create an officer resolved by hand
 * in Xero covers, by the state of its note's link. A live link already counts
 * the note, so the row adds nothing; no link means the officer's hand-made
 * note, so the row adds its recorded amount; a link recording the note
 * VOIDED or DELETED means Xero holds no note, so the row adds nothing and its
 * amount is never read. The real-PostgreSQL proof, through the card
 * self-heal, is `resolved-voided-refund-note-coverage.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";
import { countsTowardRefundNoteCoverage } from "@/lib/xero-refund-note-status";

const PAYMENT_ID = "pay-4250";
const NOTE_ID = "note-n1";

type Link = { xeroObjectId: string; active: boolean; metadata: unknown };

type Row = { id: string; correlationKey: string | null; requestPayload: unknown; xeroObjectId: string | null; responsePayload?: unknown };

/** The two reads the reader makes, over in-memory rows; links honour the `active` and `xeroObjectId` filters. */
function fakeDb(requestPayload: unknown, links: Link[], rows?: Row[]) {
  return {
    xeroSyncOperation: {
      findMany: vi.fn(async () => rows ?? [{ id: "row-n1", correlationKey: "key-n1", requestPayload, xeroObjectId: NOTE_ID }]),
    },
    xeroObjectLink: {
      findMany: vi.fn(async ({ where }: { where: { active?: boolean; xeroObjectId?: { in: string[] } } }) =>
        links.filter(
          (link) =>
            (where.active === undefined || link.active === where.active) &&
            (where.xeroObjectId === undefined || where.xeroObjectId.in.includes(link.xeroObjectId)),
        ),
      ),
    },
  } as unknown as Parameters<typeof readResolvedRefundCreditNoteCoverage>[1];
}

const READABLE = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 25_000, watermarkCents: 25_000 };
const UNREADABLE = { queueType: "REFUND_CREDIT_NOTE" };
const link = (active: boolean, status: string): Link => ({ xeroObjectId: NOTE_ID, active, metadata: { amountCents: 25_000, status } });

describe("readResolvedRefundCreditNoteCoverage: a resolved row by its note's link (#4250)", () => {
  it("unlinked (the officer's hand-made note): covers its recorded amount", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(READABLE, []));
    expect(coverage).toEqual({ coveredCents: 25_000, correlationKeys: ["key-n1"], operationIds: ["row-n1"], unreadableOperationIds: [] });
  });

  it("a live link: adds nothing here, as the link already counts the note", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(READABLE, [link(true, "AUTHORISED")]));
    expect(coverage.coveredCents).toBe(0);
    expect(coverage.operationIds).toEqual(["row-n1"]);
  });

  it("an inactive link Xero never recorded cancelled: still covers its recorded amount", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(READABLE, [link(false, "AUTHORISED")]));
    expect(coverage.coveredCents).toBe(25_000);
  });

  it.each([
    ["VOIDED", false],
    ["DELETED", false],
    // A mirror still active from before #4091: the link counts nothing either (`recoverRefundCreditNoteLinkAmountCents`).
    ["VOIDED", true],
  ] as const)("MUTATION: a link recording the note %s (active: %s) - covers nothing; its id is reported, never its key", async (status, active) => {
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(READABLE, [link(active, status)]));
    // Review (money P2): a re-raise's key can equal the voided row's, so no key fence may see it.
    expect(coverage).toEqual({ coveredCents: 0, correlationKeys: [], operationIds: ["row-n1"], unreadableOperationIds: [] });
  });

  it("an unreadable amount: refused when the note may be live, never once Xero voided it", async () => {
    expect((await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(UNREADABLE, []))).unreadableOperationIds).toEqual(["row-n1"]);
    const voided = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(UNREADABLE, [link(false, "VOIDED")]));
    expect(voided).toEqual({ coveredCents: 0, correlationKeys: [], operationIds: ["row-n1"], unreadableOperationIds: [] });
  });

  it("a legacy row whose payload says account credit is never reported, voided or not", async () => {
    const payload = { creditNotes: [{ lineItems: [{ unitAmount: 250 }] }] };
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(payload, [link(false, "VOIDED")]));
    expect(coverage.operationIds).toEqual([]);
  });

  it("MUTATION: reads the payment's refund-note links once, whatever the rows (review, concurrency F1)", async () => {
    const db = fakeDb(READABLE, [link(false, "VOIDED")], [
      { id: "row-n1", correlationKey: "key-n1", requestPayload: READABLE, xeroObjectId: NOTE_ID },
      { id: "row-n2", correlationKey: "key-n2", requestPayload: READABLE, xeroObjectId: "note-n2" },
    ]);
    await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, db);
    expect((db as unknown as { xeroObjectLink: { findMany: ReturnType<typeof vi.fn> } }).xeroObjectLink.findMany).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: each reported key's id sits at its index; rows reported without a key follow (the enqueue's fence reads by index)", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, fakeDb(READABLE, [link(false, "VOIDED")], [
      { id: "row-voided", correlationKey: "key-voided", requestPayload: READABLE, xeroObjectId: NOTE_ID },
      { id: "row-keyless", correlationKey: null, requestPayload: READABLE, xeroObjectId: null },
      { id: "row-live", correlationKey: "key-live", requestPayload: READABLE, xeroObjectId: null },
    ]));
    expect(coverage.correlationKeys).toEqual(["key-live"]);
    expect(coverage.operationIds[coverage.correlationKeys.indexOf("key-live")]).toBe("row-live");
    expect(coverage.operationIds).toEqual(["row-live", "row-voided", "row-keyless"]);
    expect(coverage.coveredCents).toBe(50_000);
  });
});

/**
 * #4265 (owner decision 26 Oct 2026): a row's coverage is its OWN note, LIVE,
 * and never a refund request's. Folded in: #4258's row closed as covered by
 * another refund's note. The real-PostgreSQL proof, through the real outbox,
 * resolve route and bank-void follow-up, is
 * `own-live-refund-note-coverage.realdb.test.ts`.
 */
describe("a row's coverage is its own live, non-request note (#4265, #4258)", () => {
  const REQUEST_PAYLOAD = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundMethod: "internet-banking", refundRequestId: "req-1" };
  const REQUEST_KEY = `payment:${PAYMENT_ID}:refund-request-credit-note:req-1:v1`;
  const COVERED = { existingCreditNoteId: NOTE_ID, coveredByExistingNote: true };

  it("the predicate: an ordinary row counts; a refund request's (by payload or by key) and a covered-by-existing row do not", () => {
    expect(countsTowardRefundNoteCoverage({ requestPayload: READABLE, responsePayload: null, correlationKey: "key-n1" })).toBe(true);
    expect(countsTowardRefundNoteCoverage({ requestPayload: REQUEST_PAYLOAD, responsePayload: null })).toBe(false);
    // A row whose payload was lost is still a request's by its key.
    expect(countsTowardRefundNoteCoverage({ requestPayload: null, responsePayload: null, correlationKey: REQUEST_KEY })).toBe(false);
    expect(countsTowardRefundNoteCoverage({ requestPayload: READABLE, responsePayload: COVERED })).toBe(false);
  });

  it("MUTATION: a refund request's note resolved by hand covers nothing; its key is still reported for the request's own fence", async () => {
    // Its link is request-role, which the payment's refund-note sets never read, live or voided: no link here.
    const coverage = await readResolvedRefundCreditNoteCoverage(
      PAYMENT_ID,
      fakeDb(REQUEST_PAYLOAD, [], [{ id: "row-rq", correlationKey: REQUEST_KEY, requestPayload: REQUEST_PAYLOAD, xeroObjectId: NOTE_ID }]),
    );
    expect(coverage).toEqual({ coveredCents: 0, correlationKeys: [REQUEST_KEY], operationIds: ["row-rq"], unreadableOperationIds: [] });
  });

  it("MUTATION: a refund request's row whose amount cannot be read refuses nothing - its amount is never read", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(
      PAYMENT_ID,
      fakeDb(null, [], [{ id: "row-rq", correlationKey: REQUEST_KEY, requestPayload: null, xeroObjectId: null }]),
    );
    expect(coverage).toEqual({ coveredCents: 0, correlationKeys: [REQUEST_KEY], operationIds: ["row-rq"], unreadableOperationIds: [] });
  });

  it("an ordinary resolved row beside it still covers its recorded amount", async () => {
    const coverage = await readResolvedRefundCreditNoteCoverage(
      PAYMENT_ID,
      fakeDb(READABLE, [], [
        { id: "row-rq", correlationKey: REQUEST_KEY, requestPayload: REQUEST_PAYLOAD, xeroObjectId: "note-rq" },
        { id: "row-n1", correlationKey: "key-n1", requestPayload: READABLE, xeroObjectId: null },
      ]),
    );
    expect(coverage.coveredCents).toBe(25_000);
    expect(coverage.correlationKeys).toEqual([REQUEST_KEY, "key-n1"]);
  });

  it("MUTATION (#4258): one refund's rows - a row closed as covered by another refund's live note counts nothing of it; the raising row still does", async () => {
    const covered = { id: "row-covered", correlationKey: "key-b", requestPayload: READABLE, xeroObjectId: NOTE_ID, responsePayload: COVERED };
    const raising = { id: "row-n1", correlationKey: "key-n1", requestPayload: READABLE, xeroObjectId: NOTE_ID, responsePayload: null };
    const liveLink = [link(true, "AUTHORISED")];
    expect(await sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, { id: "row-covered" }, fakeDb(READABLE, liveLink, [covered]) as never)).toBe(0);
    expect(await sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, { id: "row-n1" }, fakeDb(READABLE, liveLink, [raising]) as never)).toBe(25_000);
    // Both asked together: the note counts once, through the row that raised it.
    expect(await sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, {}, fakeDb(READABLE, liveLink, [covered, raising]) as never)).toBe(25_000);
  });
});
