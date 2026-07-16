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
  const currentRows = { current: [...rows] };
  const bookingFindUnique = vi.fn();
  const operationFindFirst = vi.fn();
  const operationFindMany = vi.fn();
  const operationPayload = { current: {} as Record<string, unknown> };
  const operationFindUnique = vi.fn(async () => ({
    requestPayload: operationPayload.current,
  }));
  const operationUpdate = vi.fn(async ({ data }: { data: { requestPayload: Record<string, unknown> } }) => {
    operationPayload.current = data.requestPayload;
    return {};
  });
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
  const lockLedger = vi.fn();

  const tx = {
    $executeRaw: vi.fn(),
    xeroSyncOperation: {
      findMany: operationFindMany,
      findUnique: operationFindUnique,
      update: operationUpdate,
    },
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
    currentRows,
    prisma,
    bookingFindUnique,
    operationFindFirst,
    operationFindMany,
    operationFindUnique,
    operationUpdate,
    operationPayload,
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
    lockLedger,
    tx,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: h.deriveApplied,
  lockMemberCreditLedger: h.lockLedger,
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
import { isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";

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

function providerNoteMulti(allocations: Array<[number, string]>) {
  return {
    body: {
      creditNotes: [
        {
          allocations: allocations.map(([amountCents, allocationID]) => ({
            allocationID,
            amount: amountCents / 100,
            invoice: { invoiceID: "inv-1" },
          })),
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
    h.operationFindMany.mockResolvedValue([]);
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
    };
    h.operationFindUnique.mockImplementation(async () => ({
      requestPayload: h.operationPayload.current,
    }));
    h.operationUpdate.mockImplementation(async ({ data }) => {
      h.operationPayload.current = data.requestPayload;
      return {};
    });
    h.deriveApplied.mockResolvedValue(2500);
    h.currentRows.current = h.rows.map((row) => ({ ...row }));
    h.allocationFindMany.mockImplementation(async () => h.currentRows.current);
    h.allocationUpdate.mockImplementation(async ({ where, data }) => {
      h.currentRows.current = h.currentRows.current.map((row) =>
        row.id === where.id ? { ...row, ...data } : row,
      );
      return {};
    });
    h.allocationDelete.mockImplementation(async ({ where }) => {
      h.currentRows.current = h.currentRows.current.filter(
        (row) => row.id !== where.id,
      );
      return {};
    });
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
            ledgerSnapshot: {
              desiredAppliedCents: 2500,
              rows: [{
                id: "row-1",
                xeroCreditNoteId: "cn-1",
                amountCents: 4000,
                createdAt: "2026-01-01T00:00:00.000Z",
              }],
            },
          }),
        },
      }),
    );
    expect(h.deriveApplied).toHaveBeenCalledWith("booking-1", h.tx);
    expect(h.lockLedger.mock.invocationCallOrder[0]).toBeLessThan(
      h.deriveApplied.mock.invocationCallOrder[0],
    );
    expect(h.deriveApplied.mock.invocationCallOrder[0]).toBeLessThan(
      h.operationUpdate.mock.invocationCallOrder[0],
    );
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
      "credit-note:cn-1:invoice:inv-1:deallocation-recreate:4000:2500:op:op-1:v2",
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
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({
        ledgerSnapshot: {
          desiredAppliedCents: 2500,
          rows: [{
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 2500,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        },
      }),
    );
  });

  it("scopes the recreate idempotency key to the operation so distinct operations never collide, while a retried operation reuses its key (#1887)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);

    // Each independent deallocation operation starts from the same durable
    // state (fresh ledger snapshot, provider at currentCents=4000, target=2500)
    // and must nonetheless emit a distinct recreate idempotency key.
    async function recreateKeyFor(syncOperationId: string): Promise<string> {
      h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
      };
      h.currentRows.current = h.rows.map((row) => ({ ...row }));
      h.getCreditNote
        .mockReset()
        .mockResolvedValueOnce(providerNote(4000))
        .mockResolvedValueOnce(providerNote(2500, "alloc-new"));
      h.createCreditNoteAllocation.mockClear();
      h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));

      await deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId,
      });

      const call = h.createCreditNoteAllocation.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![4] as string;
    }

    const keyOpA = await recreateKeyFor("op-A");
    const keyOpB = await recreateKeyFor("op-B");
    const keyOpARetry = await recreateKeyFor("op-A");

    // Two DISTINCT operations with identical note/invoice/current/target must
    // NOT share a key — otherwise the second op's recreate returns the first
    // op's cached Xero response and creates nothing (under-clearing).
    expect(keyOpA).not.toEqual(keyOpB);
    expect(keyOpA).toContain(":op:op-A:v2");
    expect(keyOpB).toContain(":op:op-B:v2");
    expect(keyOpA).toBe(
      "credit-note:cn-1:invoice:inv-1:deallocation-recreate:4000:2500:op:op-A:v2",
    );

    // The SAME operation retried (crash-retry) must reuse its key so Xero's
    // idempotency dedupes the duplicate recreate.
    expect(keyOpARetry).toBe(keyOpA);
  });

  it("refuses a stale durable ledger snapshot before any provider call", async () => {
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        ledgerSnapshot: {
          desiredAppliedCents: 3000,
          rows: [{
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        },
    };

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow("refusing a stale provider target");
    expect(h.getCreditNote).not.toHaveBeenCalled();
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
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
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-deleted", "alloc-remaining"],
        },
    };
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
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-old"],
          phase: "BEFORE_DELETE",
        },
    };
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

  it("requeues (busy) when the post-recreate re-GET is stale under eventual consistency, advances no PROVIDER_VERIFIED checkpoint, and converges on the next run (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // Top-of-loop sees the real pre-delete state; the post-recreate re-GET is
    // stale and still lists the just-deleted allocation (recreate not yet
    // visible).
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"))
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"));

    const busyError = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);
    expect(isXeroAppliedCreditOperationBusyError(busyError)).toBe(true);

    // The delete + recreate DID happen this run; the busy classification must
    // add no further provider mutation, advance no PROVIDER_VERIFIED checkpoint,
    // and touch no local ledger.
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1);
    expect(h.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(h.allocationUpdate).not.toHaveBeenCalled();
    expect(h.linkUpsert).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.operationUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({ phase: "PROVIDER_VERIFIED" }),
          }),
        },
      }),
    );
    // The durable BEFORE_DELETE checkpoint and a bounded requeue counter persist
    // for the retry; the ledger snapshot is not advanced.
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({
        eventualConsistencyRequeues: { "cn-1": 1 },
        checkpoint: expect.objectContaining({ phase: "BEFORE_DELETE" }),
      }),
    );

    // Next run: Xero has converged. The BEFORE_DELETE checkpoint proves the
    // provider is already at target, so it links the verified ID and completes.
    h.getCreditNote.mockReset();
    h.getCreditNote.mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1); // no new delete
    expect(h.createCreditNoteAllocation).toHaveBeenCalledTimes(1); // no new recreate
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ xeroObjectId: "alloc-new" }),
      }),
    );
    expect(h.complete).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({ desiredAppliedCents: 2500 }),
      }),
    );
  });

  it("requeues (busy) when the top-of-loop re-GET still lists the just-deleted allocations alongside the recreate, then converges (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // A prior run already issued delete+recreate (durable BEFORE_DELETE
    // checkpoint) but crashed/requeued before local apply. Xero is now stale:
    // the deleted allocation is still visible AND the recreate is visible, so
    // providerTotal (6500) exceeds currentCents and matches none of the three
    // provenance branches.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const topOfLoopBusyError = await deallocateExcessAppliedCreditForBooking(
      "booking-1",
      { syncOperationId: "op-1" },
    ).catch((err) => err);
    expect(isXeroAppliedCreditOperationBusyError(topOfLoopBusyError)).toBe(true);

    // No provider mutation at all — the stale read is classified before any
    // delete/recreate.
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({ eventualConsistencyRequeues: { "cn-1": 1 } }),
    );

    // Converged retry links the recreate and completes.
    h.getCreditNote.mockReset();
    h.getCreditNote.mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.complete).toHaveBeenCalled();
  });

  it("stays terminal (not busy) when a foreign allocation makes the post-recreate total unexplainable by eventual consistency (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"))
      // Recreate (alloc-new, 2500) PLUS a foreign allocation (alloc-foreign,
      // 2500) that no checkpoint proves: total 5000 is not a stale projection
      // of the delete+recreate.
      .mockResolvedValueOnce(
        providerNoteMulti([
          [2500, "alloc-new"],
          [2500, "alloc-foreign"],
        ]),
      );

    const error = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(false);
    expect((error as Error).message).toMatch(/verification failed/);
    expect(h.operationPayload.current.eventualConsistencyRequeues).toBeUndefined();
  });

  it("lands terminal FAILED once the bounded eventual-consistency requeue cap is exceeded, naming the exhausted note (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // Already at the cap (10): the next non-convergence must fail terminal
    // instead of requeuing forever. The counter is stored here as a LEGACY plain
    // number (the pre-per-note format) so this also exercises the back-compat
    // migration rule: a numeric value is treated as the prior count for the note
    // being requeued, so 10 -> 11 still lands terminal.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      eventualConsistencyRequeues: 10,
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const error = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(false);
    expect((error as Error).message).toMatch(
      /did not converge after 10 eventual-consistency requeues for credit note cn-1/,
    );
  });

  it("keeps the eventual-consistency requeue budget per credit note so converging notes don't exhaust each other's cap (#1924 review, #1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // cn-2 has already requeued 4 times (converging independently) and cn-1 has
    // requeued 3 times, both well under the cap. A fresh stale top-of-loop read
    // for cn-1 must bump ONLY cn-1's budget (3 -> 4) and stay busy — cn-2's
    // separate count of 4 must not push cn-1 over the shared-in-the-old-design
    // cap and land the operation terminal FAILED spuriously.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      eventualConsistencyRequeues: { "cn-1": 3, "cn-2": 4 },
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const busyError = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    // Under the cap on both notes: transient busy requeue, never terminal.
    expect(isXeroAppliedCreditOperationBusyError(busyError)).toBe(true);
    // Only cn-1 advanced; cn-2's independent budget is untouched.
    expect(h.operationPayload.current.eventualConsistencyRequeues).toEqual({
      "cn-1": 4,
      "cn-2": 4,
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
