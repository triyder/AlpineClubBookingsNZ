/**
 * #4288 (`INV-ADDPAY-041`, owner decision 24 Oct 2026): the one order of two
 * writes to one refund-note link (`judgeRefundNoteWrite`), and the one shape
 * of a Xero snapshot on a link (`xeroCreditNoteSnapshotMetadata`), which
 * stamps the status with the `UpdatedDateUTC` it was read at.
 */
import { describe, expect, it } from "vitest";
import {
  judgedRefundNoteReading,
  judgeRefundNoteWrite,
  readRefundNoteSnapshotAt,
  REFUND_NOTE_SNAPSHOT_AT_KEY,
  withoutVoidedRefundNoteLinks,
  xeroCreditNoteSnapshotMetadata,
} from "@/lib/xero-refund-note-status";

const at = (status: string, iso?: string) => ({ status, total: 200, ...(iso ? { [REFUND_NOTE_SNAPSHOT_AT_KEY]: iso } : {}) });
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

describe("judgeRefundNoteWrite (#4288)", () => {
  it("MUTATION (early return): an older live reading never overwrites a stored void", () => {
    expect(judgeRefundNoteWrite(at("AUTHORISED", EARLY), at("VOIDED", LATE))).toBe("keep-stored-snapshot");
    expect(judgeRefundNoteWrite(at("PAID", EARLY), at("DELETED", LATE))).toBe("keep-stored-snapshot");
    expect(judgeRefundNoteWrite(at("authorised", EARLY), at("voided", LATE))).toBe("keep-stored-snapshot");
  });

  it("a live reading never overwrites a stored void whatever the stamps say: a void is terminal in Xero", () => {
    expect(judgeRefundNoteWrite(at("AUTHORISED", LATE), at("VOIDED", EARLY))).toBe("keep-stored-snapshot");
  });

  it("MUTATION (fallback): with no timestamp on either side a stored void still wins over a live status", () => {
    expect(judgeRefundNoteWrite(at("AUTHORISED"), at("VOIDED"))).toBe("keep-stored-snapshot");
    expect(judgeRefundNoteWrite(at("AUTHORISED", LATE), at("VOIDED"))).toBe("keep-stored-snapshot");
    expect(judgeRefundNoteWrite(at("AUTHORISED"), at("DELETED", EARLY))).toBe("keep-stored-snapshot");
  });

  it("equal timestamps are the same snapshot: applied, except a live status over a stored void", () => {
    expect(judgeRefundNoteWrite(at("PAID", LATE), at("AUTHORISED", LATE))).toBe("apply");
    expect(judgeRefundNoteWrite(at("AUTHORISED", LATE), at("VOIDED", LATE))).toBe("keep-stored-snapshot");
  });

  it("MUTATION (order): between two live readings, an older one keeps the stored snapshot; a newer one applies", () => {
    expect(judgeRefundNoteWrite(at("AUTHORISED", EARLY), at("PAID", LATE))).toBe("keep-stored-snapshot");
    // AUTHORISED -> PAID is ordinary.
    expect(judgeRefundNoteWrite(at("PAID", LATE), at("AUTHORISED", EARLY))).toBe("apply");
  });

  it("between two live readings, a missing timestamp on either side applies", () => {
    expect(judgeRefundNoteWrite(at("AUTHORISED"), at("PAID", LATE))).toBe("apply");
    expect(judgeRefundNoteWrite(at("AUTHORISED", EARLY), at("PAID"))).toBe("apply");
  });

  it("an incoming void is always applied, older or not", () => {
    expect(judgeRefundNoteWrite(at("VOIDED", EARLY), at("AUTHORISED", LATE))).toBe("apply");
    expect(judgeRefundNoteWrite(at("DELETED"), at("PAID", LATE))).toBe("apply");
    expect(judgeRefundNoteWrite(at("VOIDED", EARLY), at("VOIDED", LATE))).toBe("apply");
  });

  it("a write naming no status keeps only a stored void's status (#4223); a row with no status takes any write", () => {
    expect(judgeRefundNoteWrite({ amountCents: 100 }, at("VOIDED", LATE))).toBe("keep-stored-status");
    expect(judgeRefundNoteWrite(undefined, at("DELETED"))).toBe("keep-stored-status");
    expect(judgeRefundNoteWrite({ amountCents: 100 }, at("AUTHORISED", LATE))).toBe("apply");
    expect(judgeRefundNoteWrite(at("AUTHORISED", EARLY), null)).toBe("apply");
    expect(judgeRefundNoteWrite(at("AUTHORISED", EARLY), { amountCents: 100 })).toBe("apply");
  });
});

describe("xeroCreditNoteSnapshotMetadata (#4288)", () => {
  it("records the status with the UpdatedDateUTC it was read at, however the SDK or wire spells it", () => {
    const fromSdk = xeroCreditNoteSnapshotMetadata({ status: "AUTHORISED", total: 200, appliedAmount: 0, remainingCredit: 200, updatedDateUTC: new Date(LATE) });
    expect(fromSdk).toEqual({ status: "AUTHORISED", total: 200, appliedAmount: 0, remainingCredit: 200, providerUpdatedAt: LATE });
    const fromWire = xeroCreditNoteSnapshotMetadata({ status: "PAID", updatedDateUTC: `/Date(${Date.parse(LATE)}+0000)/` });
    expect(fromWire).toEqual({ status: "PAID", total: null, appliedAmount: null, remainingCredit: null, providerUpdatedAt: LATE });
    expect(readRefundNoteSnapshotAt(fromWire)?.toISOString()).toBe(LATE);
  });

  it("records null, never a guess, when Xero sent no readable timestamp", () => {
    expect(xeroCreditNoteSnapshotMetadata({ status: "AUTHORISED" }).providerUpdatedAt).toBeNull();
    expect(xeroCreditNoteSnapshotMetadata({ status: "AUTHORISED", updatedDateUTC: new Date(Number.NaN) }).providerUpdatedAt).toBeNull();
    expect(readRefundNoteSnapshotAt({ status: "AUTHORISED", providerUpdatedAt: null })).toBeNull();
  });
});

describe("judgedRefundNoteReading (#4288)", () => {
  /** What the link funnel leaves on the row: the reading merged over it, or the row as it was. */
  const funnelWrite = (stored: Record<string, unknown>, reading: Record<string, unknown>) =>
    judgeRefundNoteWrite(reading, stored) === "apply" ? { ...stored, ...reading } : stored;
  const SNAPSHOTS = [
    at("AUTHORISED", EARLY), at("AUTHORISED", LATE), at("PAID", EARLY), at("PAID", LATE), at("AUTHORISED"), at("PAID"),
    at("VOIDED", EARLY), at("VOIDED", LATE), at("VOIDED"), at("DELETED", LATE),
  ];

  it("MUTATION: is stale exactly when the funnel kept the stored snapshot over the reading, for every pair", () => {
    for (const stored of SNAPSHOTS) {
      // A reading always carries the stamp's key, null when Xero sent none (the builder's shape).
      for (const reading of SNAPSHOTS.map((snapshot) => ({ [REFUND_NOTE_SNAPSHOT_AT_KEY]: null, ...snapshot }))) {
        const written = { metadata: funnelWrite(stored, reading) };
        const verdict = judgeRefundNoteWrite(reading, stored);
        expect(judgedRefundNoteReading(reading, written).stale, `${JSON.stringify(reading)} over ${JSON.stringify(stored)}`).toBe(verdict === "keep-stored-snapshot");
      }
    }
  });

  it("an applied reading over a row with keys of its own is not stale", () => {
    expect(judgedRefundNoteReading(at("PAID", LATE), { metadata: { amountCents: 100, handBackTaskId: "t", ...at("PAID", LATE) } })).toEqual({ stale: false });
    expect(judgedRefundNoteReading(at("AUTHORISED", EARLY), { metadata: at("VOIDED", LATE) })).toEqual({ stale: true });
  });
});

describe("withoutVoidedRefundNoteLinks (#4288 review 4)", () => {
  type Row = { localModel: string; localId: string; xeroObjectType: string; xeroObjectId: string; role: string; active: boolean; metadata: unknown };
  /** A link store that answers the reader's where-clause, as Prisma would. */
  const store = (rows: Row[]) => ({
    xeroObjectLink: {
      findMany: async ({ where }: { where: { localModel: string; xeroObjectType: string; role: string; xeroObjectId: string; localId: { in: string[] } } }) =>
        rows.filter((row) => row.localModel === where.localModel && row.xeroObjectType === where.xeroObjectType && row.role === where.role
          && row.xeroObjectId === where.xeroObjectId && where.localId.in.includes(row.localId)),
    },
  }) as never;
  const row = (localId: string, role: string, status: string): Row =>
    ({ localModel: "Payment", localId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_1", role, active: status !== "VOIDED", metadata: { status } });
  const link = (localId: string, role: string) => ({ localModel: "Payment", localId, xeroObjectType: "CREDIT_NOTE", role });

  it("MUTATION: drops the links of a refund request's own note voided now, as it does a payment's own", async () => {
    const db = store([row("pay_request", "REFUND_REQUEST_CREDIT_NOTE", "VOIDED"), row("pay_own", "REFUND_CREDIT_NOTE", "VOIDED"), row("pay_live", "REFUND_CREDIT_NOTE", "AUTHORISED")]);
    const links = [link("pay_request", "REFUND_REQUEST_CREDIT_NOTE"), link("pay_own", "REFUND_CREDIT_NOTE"), link("pay_live", "REFUND_CREDIT_NOTE"), link("pay_credit", "ACCOUNT_CREDIT_NOTE")];
    expect(await withoutVoidedRefundNoteLinks("cn_1", links, db)).toEqual([link("pay_live", "REFUND_CREDIT_NOTE"), link("pay_credit", "ACCOUNT_CREDIT_NOTE")]);
  });

  it("a payment's void in one role never drops its link in the other", async () => {
    const db = store([row("pay_1", "REFUND_CREDIT_NOTE", "VOIDED"), row("pay_1", "REFUND_REQUEST_CREDIT_NOTE", "AUTHORISED")]);
    expect(await withoutVoidedRefundNoteLinks("cn_1", [link("pay_1", "REFUND_REQUEST_CREDIT_NOTE")], db)).toEqual([link("pay_1", "REFUND_REQUEST_CREDIT_NOTE")]);
  });
});
