import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2901 operator status recorder: inbound reconciliation structurally cannot
 * stamp `metadata.status` onto an INACTIVE refund-note link, so the repair
 * refuses to reactivate unknown-status links and this recorder is the honest
 * path that records them — read-only at the provider (GET each linked note
 * once), local link-metadata merges through the normal upsert funnel.
 */

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getCreditNote: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.paymentFindMany },
    xeroObjectLink: { findMany: mocks.linkFindMany },
  },
}));

vi.mock("@/lib/xero-api-client", () => ({
  // Run the wrapped call directly; the real wrapper persists metered usage to
  // prisma, which is not modelled in this unit test.
  callXeroApi: (fn: () => unknown) => fn(),
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
}));

vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  formatStripeRefundNoteStatusRecordResult,
  recordStripeRefundNoteLinkStatuses,
} from "@/lib/xero-refund-note-status-recorder";

function xeroClientReturning() {
  return {
    xero: { accountingApi: { getCreditNote: mocks.getCreditNote } },
    tenantId: "tenant_1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedXeroClient.mockResolvedValue(xeroClientReturning());
  mocks.upsertXeroObjectLink.mockResolvedValue({});
});

describe("recordStripeRefundNoteLinkStatuses", () => {
  it("fetches each linked note once and merges its live status onto every link row, active or not", async () => {
    mocks.paymentFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mocks.linkFindMany.mockResolvedValue([
      // The same note linked from two payments: one provider GET, two merges.
      { localId: "p1", xeroObjectId: "cn_a", xeroObjectNumber: "CN-0001", active: true },
      { localId: "p2", xeroObjectId: "cn_a", xeroObjectNumber: "CN-0001", active: false },
      { localId: "p1", xeroObjectId: "cn_b", xeroObjectNumber: null, active: false },
    ]);
    mocks.getCreditNote.mockImplementation(async (_tenantId: string, noteId: string) => ({
      body: {
        creditNotes: [
          noteId === "cn_a"
            ? {
                creditNoteID: "cn_a",
                creditNoteNumber: "CN-0001",
                status: "AUTHORISED",
                total: 90,
                appliedAmount: 90,
                remainingCredit: 0,
                updatedDateUTC: new Date("2026-06-30T09:30:00.000Z"),
              }
            : {
                creditNoteID: "cn_b",
                creditNoteNumber: "CN-0002",
                status: "VOIDED",
                total: 10,
                appliedAmount: 0,
                remainingCredit: 0,
              },
        ],
      },
    }));

    const result = await recordStripeRefundNoteLinkStatuses();

    expect(result).toEqual({
      scannedPayments: 2,
      checkedNotes: 2,
      updatedLinks: 3,
      failedNotes: [],
    });
    expect(mocks.getCreditNote).toHaveBeenCalledTimes(2);

    // Recording is never a reactivation: the CURRENT active state passes
    // through, and the funnel's own cancelled-mirror rule is the only
    // transition it can cause. Metadata merges (mergeMetadata: true) so the
    // outbound {amountCents, watermarkCents} survive.
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledTimes(3);
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith({
      localModel: "Payment",
      localId: "p2",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_a",
      xeroObjectNumber: "CN-0001",
      role: "REFUND_CREDIT_NOTE",
      active: false,
      metadata: {
        status: "AUTHORISED",
        total: 90,
        appliedAmount: 90,
        remainingCredit: 0,
        // #4288: the reading's own Xero timestamp, which orders it under the row lock.
        providerUpdatedAt: "2026-06-30T09:30:00.000Z",
      },
      mergeMetadata: true,
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: "p1",
        xeroObjectId: "cn_b",
        xeroObjectNumber: "CN-0002",
        active: false,
        // No timestamp from Xero: recorded as null, never a guess.
        metadata: expect.objectContaining({ status: "VOIDED", providerUpdatedAt: null }),
      })
    );
  });

  it("records a failed GET as a failure and keeps recording the other notes (fail closed)", async () => {
    mocks.paymentFindMany.mockResolvedValue([{ id: "p1" }]);
    mocks.linkFindMany.mockResolvedValue([
      { localId: "p1", xeroObjectId: "cn_gone", xeroObjectNumber: null, active: false },
      { localId: "p1", xeroObjectId: "cn_live", xeroObjectNumber: null, active: true },
    ]);
    mocks.getCreditNote.mockImplementation(async (_tenantId: string, noteId: string) => {
      if (noteId === "cn_gone") {
        throw new Error("Xero 404");
      }
      return {
        body: {
          creditNotes: [
            { creditNoteID: "cn_live", status: "AUTHORISED", total: 90 },
          ],
        },
      };
    });

    const result = await recordStripeRefundNoteLinkStatuses();

    expect(result.checkedNotes).toBe(1);
    expect(result.updatedLinks).toBe(1);
    expect(result.failedNotes).toEqual([
      { xeroObjectId: "cn_gone", error: "Xero 404" },
    ]);
    // The failed note's links were never written — they stay status-unknown,
    // which the repair refuses to reactivate.
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledTimes(1);
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectId: "cn_live" })
    );
  });

  it("records an empty provider response for a note as a failure, not a success", async () => {
    mocks.paymentFindMany.mockResolvedValue([{ id: "p1" }]);
    mocks.linkFindMany.mockResolvedValue([
      { localId: "p1", xeroObjectId: "cn_missing", xeroObjectNumber: null, active: false },
    ]);
    mocks.getCreditNote.mockResolvedValue({ body: { creditNotes: [] } });

    const result = await recordStripeRefundNoteLinkStatuses();

    expect(result.checkedNotes).toBe(0);
    expect(result.updatedLinks).toBe(0);
    expect(result.failedNotes).toEqual([
      {
        xeroObjectId: "cn_missing",
        error: "Xero credit note cn_missing was not found",
      },
    ]);
    expect(mocks.upsertXeroObjectLink).not.toHaveBeenCalled();
  });

  it("makes no provider call at all when the scan finds no refund-note links", async () => {
    mocks.paymentFindMany.mockResolvedValue([{ id: "p1" }]);
    mocks.linkFindMany.mockResolvedValue([]);

    const result = await recordStripeRefundNoteLinkStatuses();

    expect(result).toEqual({
      scannedPayments: 1,
      checkedNotes: 0,
      updatedLinks: 0,
      failedNotes: [],
    });
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
  });

  it("scopes the scan to the given payment ids and to refunded, Xero-invoiced Stripe payments", async () => {
    mocks.paymentFindMany.mockResolvedValue([]);

    await recordStripeRefundNoteLinkStatuses({ paymentIds: ["p42"] });

    expect(mocks.paymentFindMany).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        refundedAmountCents: { gt: 0 },
        xeroInvoiceId: { not: null },
        id: { in: ["p42"] },
      },
      select: { id: true },
    });
    // Nothing matched, so no link scan and no provider call.
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("queries only the payments' own REFUND_CREDIT_NOTE links (never other roles or models)", async () => {
    mocks.paymentFindMany.mockResolvedValue([{ id: "p1" }]);
    mocks.linkFindMany.mockResolvedValue([]);

    await recordStripeRefundNoteLinkStatuses();

    expect(mocks.linkFindMany).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: { in: ["p1"] },
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
      },
      select: {
        localId: true,
        xeroObjectId: true,
        xeroObjectNumber: true,
        active: true,
      },
    });
  });
});

describe("formatStripeRefundNoteStatusRecordResult", () => {
  it("summarises the run and names every failed note as staying status-unknown", () => {
    const text = formatStripeRefundNoteStatusRecordResult({
      scannedPayments: 3,
      checkedNotes: 2,
      updatedLinks: 4,
      failedNotes: [{ xeroObjectId: "cn_gone", error: "Xero 404" }],
    });

    expect(text).toContain(
      "Recorded live Xero statuses: 2 note(s) fetched, 4 link(s) updated across 3 payment(s)."
    );
    expect(text).toContain(
      "FAILED cn_gone: Xero 404 — its links stay status-unknown and are never reactivated."
    );
  });
});
