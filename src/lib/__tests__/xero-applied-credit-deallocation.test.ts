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
    xeroObjectLink: { findMany: linkFindMany },
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
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
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

function regularAllocationLink() {
  return {
    id: "link-row-1",
    localModel: "MemberCreditNoteAllocation",
    localId: "row-1",
    xeroObjectId: "cn-1:inv-1:4000",
    role: "APPLIED_CREDIT_ALLOCATION",
    metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 4000 },
  };
}

function remainderAllocationLink() {
  return {
    id: "link-payment-1",
    localModel: "Payment",
    localId: "payment-1",
    xeroObjectId: "cn-1:inv-1:4000",
    role: "APPLIED_CREDIT_REMAINDER_ALLOCATION",
    metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 4000 },
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
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
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
    expect(h.linkUpdateMany).toHaveBeenCalled();
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localModel: "MemberCreditNoteAllocation",
          localId: "row-1",
          xeroObjectId: "alloc-new",
          active: true,
          metadata: expect.objectContaining({
            providerAllocationIdVerified: true,
            rowTargetCents: 2500,
          }),
        }),
      })
    );
    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({
              rowTargets: [
                { id: "row-1", currentCents: 4000, targetCents: 2500 },
              ],
              providerAllocations: [
                { allocationID: "alloc-new", amountCents: 2500 },
              ],
              phase: "PROVIDER_VERIFIED",
            }),
          }),
        },
      })
    );
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

  it("refuses a same-total provider allocation with no local/checkpoint provenance", async () => {
    h.linkFindMany.mockResolvedValue([]);
    h.getCreditNote.mockResolvedValue(
      providerNote(4000, "manual-same-total-allocation")
    );

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      })
    ).rejects.toThrow(/Ambiguous Xero allocation total/);

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
  });

  it("resumes a checkpointed partial delete without guessing", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
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

  it("heals a crash after recreate by linking the verified actual ID without recreating", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.operationFindUnique.mockResolvedValue({
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-old"],
          phase: "BEFORE_DELETE",
        },
      },
    });
    h.getCreditNote.mockResolvedValue(providerNote(2500, "alloc-recreated"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 2500 },
    });
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ xeroObjectId: "alloc-recreated" }),
      })
    );
  });

  it("reconciles a minted-remainder Payment link to the actual replacement ID", async () => {
    h.linkFindMany.mockResolvedValue([remainderAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-remainder-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localModel: "Payment",
          localId: "payment-1",
          role: "APPLIED_CREDIT_REMAINDER_ALLOCATION",
          xeroObjectId: "alloc-remainder-new",
        }),
      })
    );
  });

  it("reconciles multiple local rows on one note to the surviving actual allocation", async () => {
    const rows = [
      { id: "row-1", xeroCreditNoteId: "cn-1", amountCents: 2000, createdAt: new Date("2026-01-01") },
      { id: "row-2", xeroCreditNoteId: "cn-1", amountCents: 2000, createdAt: new Date("2026-02-01") },
    ];
    h.deriveApplied.mockResolvedValue(1500);
    h.allocationFindMany.mockResolvedValue(rows);
    h.linkFindMany.mockResolvedValue([
      {
        ...regularAllocationLink(),
        localId: "row-1",
        id: "link-row-1",
        metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 2000 },
      },
      {
        ...regularAllocationLink(),
        localId: "row-2",
        id: "link-row-2",
        metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 2000 },
      },
    ]);
    h.getCreditNote
      .mockResolvedValueOnce({
        body: {
          creditNotes: [{
            allocations: [
              { allocationID: "alloc-a", amount: 20, invoice: { invoiceID: "inv-1" } },
              { allocationID: "alloc-b", amount: 20, invoice: { invoiceID: "inv-1" } },
            ],
          }],
        },
      })
      .mockResolvedValueOnce(providerNote(1500, "alloc-survivor"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 1500 },
    });
    expect(h.allocationDelete).toHaveBeenCalledWith({ where: { id: "row-2" } });
    expect(h.linkUpsert).toHaveBeenCalledTimes(1);
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localId: "row-1",
          xeroObjectId: "alloc-survivor",
        }),
      })
    );
  });

  it("deactivates regular links and creates none when the target is zero", async () => {
    h.deriveApplied.mockResolvedValue(0);
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(0));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationDelete).toHaveBeenCalledWith({ where: { id: "row-1" } });
    expect(h.linkUpdateMany).toHaveBeenCalled();
    expect(h.linkUpsert).not.toHaveBeenCalled();
  });

  it("deactivates a minted-remainder Payment link with no replacement at zero", async () => {
    h.deriveApplied.mockResolvedValue(0);
    h.linkFindMany.mockResolvedValue([remainderAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(0));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ id: { in: ["link-payment-1"] } }),
          ]),
        }),
      })
    );
    expect(h.linkUpsert).not.toHaveBeenCalled();
  });

  it("persists explicit Xero-read provenance before deleting a same-total legacy/manual ID", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "actual-id-not-in-legacy-link"))
      .mockResolvedValueOnce(providerNote(2500, "actual-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({
              phase: "BEFORE_DELETE",
              providerMatch: "LOCAL_LINK_TOTAL_AND_XERO_NOTE_INVOICE_MATCH",
              allocationIds: ["actual-id-not-in-legacy-link"],
              priorLinks: [expect.objectContaining({ id: "link-row-1" })],
            }),
          }),
        },
      })
    );
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
