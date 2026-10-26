/**
 * `INV-ADDPAY-041` (#4091): what a refund note's key gains after a void
 * (`refundNoteKeyAfterVoidParts`), over a fake client - the figures a link
 * records, the create row's payload when the link records none, and failing
 * closed when neither does.
 */
import { describe, expect, it } from "vitest";
import { assertFreshRefundNoteFromCreate, refundNoteKeyAfterVoidParts, refundRequestOwnNotes } from "@/lib/xero-refund-note-status";

type Link = { xeroObjectId: string; metadata: unknown };
type Create = { xeroObjectId: string; requestPayload: unknown; createdAt?: Date };

function client(links: Link[], creates: Create[] = []) {
  return {
    xeroObjectLink: { findMany: async () => links },
    xeroSyncOperation: {
      // Honours the read's createdAt order, as the database does.
      findFirst: async ({ where, orderBy }: { where: { xeroObjectId: string }; orderBy?: { createdAt?: "asc" | "desc" } }) => {
        const matching = creates.filter((create) => create.xeroObjectId === where.xeroObjectId);
        const time = (create: Create) => create.createdAt?.getTime() ?? 0;
        matching.sort((a, b) => (orderBy?.createdAt === "desc" ? time(b) - time(a) : time(a) - time(b)));
        return matching[0] ?? null;
      },
      findMany: async () => [],
    },
  } as never;
}

describe("INV-ADDPAY-041: the after-void key parts", () => {
  it("adds nothing while no refund note on the payment is voided, even at a live note's base", async () => {
    const db = client([{ xeroObjectId: "cn_live", metadata: { amountCents: 5000, watermarkCents: 5000 } }]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 5000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a voided link with no figures is matched by its create row's amount", async () => {
    // An inbound-written link: status only. Its create row recorded $50.
    const db = client(
      [{ xeroObjectId: "cn_voided", metadata: { status: "VOIDED", total: 50 } }],
      [{ xeroObjectId: "cn_voided", requestPayload: { allocation: { invoiceId: "inv_1", amount: 50 } } }],
    );
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 5000 }, db)).toEqual(["after-void", "cn_voided"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 7000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a voided link with no figures is matched by its queued create's watermark", async () => {
    const db = client(
      [{ xeroObjectId: "cn_voided", metadata: { status: "VOIDED" } }],
      [{ xeroObjectId: "cn_voided", requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 3000, watermarkCents: 8000 } }],
    );
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 8000 }, db)).toEqual(["after-void", "cn_voided"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 5000 }, db)).toEqual([]);
  });

  it("MUTATION (final-round check): a link with no figures reads the create that RAISED it, not a later row closed as covered by it", async () => {
    const db = client(
      [{ xeroObjectId: "cn_voided", metadata: { status: "VOIDED" } }],
      [
        { xeroObjectId: "cn_voided", createdAt: new Date("2026-06-01T00:00:00.000Z"), requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 3000, watermarkCents: 8000 } },
        { xeroObjectId: "cn_voided", createdAt: new Date("2026-06-02T00:00:00.000Z"), requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 1000, watermarkCents: 9000 } },
      ],
    );
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 8000 }, db)).toEqual(["after-void", "cn_voided"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 9000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a link whose figure nothing records fails closed - it is named whatever the base", async () => {
    const db = client([{ xeroObjectId: "cn_legacy", metadata: { status: "DELETED" } }]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 1234 }, db)).toEqual(["after-void", "cn_legacy"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 99 }, db)).toEqual(["after-void", "cn_legacy"]);
  });

  it("names a live note at the key's base once a void exists, sorted with the voided ones", async () => {
    const db = client([
      { xeroObjectId: "cn_b", metadata: { amountCents: 3000, watermarkCents: 8000 } },
      { xeroObjectId: "cn_a", metadata: { amountCents: 5000, watermarkCents: 8000, status: "VOIDED" } },
      { xeroObjectId: "cn_c", metadata: { amountCents: 1000, watermarkCents: 9000 } },
    ]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 8000 }, db)).toEqual(["after-void", "cn_a", "cn_b"]);
  });
});

describe("#4195: a refund request's own notes, and the key it raises a fresh one under", () => {
  type RoleLink = Link & { role: string; active: boolean; xeroObjectNumber?: string | null };
  function roleClient(links: RoleLink[]) {
    return {
      xeroObjectLink: { findMany: async ({ where }: { where: { role: string } }) => links.filter((link) => link.role === where.role) },
      xeroSyncOperation: { findFirst: async () => null, findMany: async () => [] },
    } as never;
  }
  const request = (xeroObjectId: string, refundRequestId: string, extra: Partial<RoleLink> & { status?: string } = {}): RoleLink => ({
    xeroObjectId,
    role: "REFUND_REQUEST_CREDIT_NOTE",
    active: extra.active ?? true,
    metadata: { amountCents: 5000, refundRequestId, ...(extra.status ? { status: extra.status } : {}) },
  });

  it("MUTATION: a voided own note is never live, inactive or still active from before #4195", async () => {
    const db = roleClient([
      request("cn_old", "rr_1", { status: "VOIDED" }),
      request("cn_older", "rr_1", { status: "DELETED", active: false }),
      request("cn_other", "rr_2"),
    ]);
    expect(await refundRequestOwnNotes("pay_1", "rr_1", db)).toEqual({ live: null, cancelledIds: ["cn_old", "cn_older"] });
    expect((await refundRequestOwnNotes("pay_1", "rr_2", db)).live?.xeroObjectId).toBe("cn_other");
  });

  it("a live own note is the request's cover; an inactive note with no recorded status is not", async () => {
    const db = roleClient([request("cn_inactive", "rr_1", { active: false }), request("cn_live", "rr_1", { status: "AUTHORISED" })]);
    expect(await refundRequestOwnNotes("pay_1", "rr_1", db)).toMatchObject({ live: { xeroObjectId: "cn_live" }, cancelledIds: [] });
  });

  it("MUTATION: the request's key names its own voided notes, sorted, and nothing else's", async () => {
    const db = roleClient([
      request("cn_b", "rr_1", { status: "VOIDED", active: false }),
      request("cn_a", "rr_1", { status: "VOIDED", active: false }),
      request("cn_x", "rr_2", { status: "VOIDED", active: false }),
      { xeroObjectId: "cn_canonical", role: "REFUND_CREDIT_NOTE", active: false, metadata: { amountCents: 5000, status: "VOIDED" } },
    ]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { refundRequestId: "rr_1" }, db)).toEqual(["after-void", "cn_a", "cn_b"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { refundRequestId: "rr_3" }, db)).toEqual([]);
  });

  it("MUTATION: Xero answering a create with a note any refund request's link records voided is refused", async () => {
    // A link whose request is unreadable: no request names it, so only this check stops it.
    const db = roleClient([{ xeroObjectId: "cn_voided", role: "REFUND_REQUEST_CREDIT_NOTE", active: false, metadata: { status: "VOIDED" } }]);
    await expect(assertFreshRefundNoteFromCreate("pay_1", "op_1", { creditNoteID: "cn_voided", status: "AUTHORISED" }, db)).rejects.toThrow(
      /never re-adopted \(INV-ADDPAY-041\)/,
    );
    await expect(assertFreshRefundNoteFromCreate("pay_1", "op_1", { creditNoteID: "cn_fresh", status: "AUTHORISED" }, db)).resolves.toBeUndefined();
  });
});
