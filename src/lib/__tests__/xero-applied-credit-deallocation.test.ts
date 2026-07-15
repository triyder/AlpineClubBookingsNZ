import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const rows = [
    {
      id: "row-1",
      xeroCreditNoteId: "cn-1",
      amountCents: 4000,
      createdAt: new Date("2026-01-01"),
    },
  ];
  const bookingFindUnique = vi.fn();
  const operationFindFirst = vi.fn();
  const operationFindUnique = vi.fn();
  const operationUpdate = vi.fn();
  const allocationFindMany = vi.fn();
  const allocationDelete = vi.fn();
  const allocationUpdate = vi.fn();
  const linkUpdateMany = vi.fn();
  const linkFindMany = vi.fn();
  const linkUpsert = vi.fn();
  const getCreditNote = vi.fn();
  const deleteCreditNoteAllocations = vi.fn();
  const createCreditNoteAllocation = vi.fn();
  const complete = vi.fn();
  const fail = vi.fn();
  const deriveApplied = vi.fn();

  const tx = {
    $executeRaw: vi.fn(),
    memberCreditNoteAllocation: {
      findMany: allocationFindMany,
      delete: allocationDelete,
      update: allocationUpdate,
    },
    xeroObjectLink: {
      updateMany: linkUpdateMany,
      findMany: linkFindMany,
      upsert: linkUpsert,
    },
  };
  const prisma = {
    booking: { findUnique: bookingFindUnique },
    xeroSyncOperation: {
      findFirst: operationFindFirst,
      findUnique: operationFindUnique,
      update: operationUpdate,
    },
    memberCreditNoteAllocation: { findMany: allocationFindMany },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    rows,
    prisma,
    bookingFindUnique,
    operationFindFirst,
    operationFindUnique,
    operationUpdate,
    allocationFindMany,
    allocationDelete,
    allocationUpdate,
    linkUpdateMany,
    linkFindMany,
    linkUpsert,
    getCreditNote,
    deleteCreditNoteAllocations,
    createCreditNoteAllocation,
    complete,
    fail,
    deriveApplied,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: h.deriveApplied,
  lockMemberCreditLedger: vi.fn(),
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getCreditNote: h.getCreditNote,
        deleteCreditNoteAllocations: h.deleteCreditNoteAllocations,
        createCreditNoteAllocation: h.createCreditNoteAllocation,
      },
    },
  })),
  callXeroApi: vi.fn(async (runner: () => unknown) => runner()),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  completeXeroSyncOperation: h.complete,
  failXeroSyncOperation: h.fail,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deallocateExcessAppliedCreditForBooking,
  planAppliedCreditDeallocation,
} from "@/lib/xero-applied-credit-deallocation";

function providerNote(amountCents: number, allocationID = "alloc-1") {
  return {
    body: {
      creditNotes: [
        {
          allocations:
            amountCents === 0
              ? []
              : [
                  {
                    allocationID,
                    amount: amountCents / 100,
                    invoice: { invoiceID: "inv-1" },
                  },
                ],
        },
      ],
    },
  };
}

describe("deallocateExcessAppliedCreditForBooking (#1887 F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      payment: {
        id: "payment-1",
        source: "INTERNET_BANKING",
        xeroInvoiceId: "inv-1",
      },
    });
    h.operationFindFirst.mockResolvedValue(null);
    h.operationFindUnique.mockResolvedValue({
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
      },
    });
    h.deriveApplied.mockResolvedValue(2500);
    h.allocationFindMany.mockResolvedValue(h.rows);
    h.linkFindMany.mockResolvedValue([]);
    h.deleteCreditNoteAllocations.mockResolvedValue({
      body: { isDeleted: true },
    });
    h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));
  });

  it("checkpoints the real allocation ID, deletes, recreates the exact target, then reduces local cents", async () => {
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({ allocationIds: ["alloc-1"] }),
          }),
        },
      }),
    );
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledWith(
      "tenant-1",
      "cn-1",
      "alloc-1",
    );
    expect(h.createCreditNoteAllocation).toHaveBeenCalledWith(
      "tenant-1",
      "cn-1",
      { allocations: [expect.objectContaining({ amount: 25 })] },
      undefined,
      "credit-note:cn-1:invoice:inv-1:deallocation-recreate:4000:2500:v1",
    );
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.complete).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({ desiredAppliedCents: 2500 }),
      }),
    );
  });

  it("refuses an ambiguous provider total without deleting anything", async () => {
    h.getCreditNote.mockResolvedValue(providerNote(3500, "manual-or-drifted"));

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow(/Ambiguous Xero allocation total/);

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).not.toHaveBeenCalled();
  });

  it("resumes a checkpointed partial delete without guessing", async () => {
    h.operationFindUnique.mockResolvedValue({
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-deleted", "alloc-remaining"],
        },
      },
    });
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(2000, "alloc-remaining"))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1);
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledWith(
      "tenant-1", "cn-1", "alloc-remaining",
    );
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 2500 },
    });
  });
});

describe("planAppliedCreditDeallocation", () => {
  it("reduces multiple notes exactly and groups multiple lots on one note", () => {
    const groups = planAppliedCreditDeallocation(
      [
        { id: "old", xeroCreditNoteId: "cn-old", amountCents: 2000, createdAt: new Date("2026-01-01") },
        { id: "new-a", xeroCreditNoteId: "cn-new", amountCents: 1000, createdAt: new Date("2026-02-01") },
        { id: "new-b", xeroCreditNoteId: "cn-new", amountCents: 1000, createdAt: new Date("2026-02-02") },
      ],
      1500,
    );
    expect(groups.map((group) => ({ note: group.xeroCreditNoteId, target: group.targetCents })))
      .toEqual([{ note: "cn-old", target: 1500 }, { note: "cn-new", target: 0 }]);
    expect(groups[1].rowTargets).toEqual([
      { id: "new-a", currentCents: 1000, targetCents: 0 },
      { id: "new-b", currentCents: 1000, targetCents: 0 },
    ]);
  });
});
