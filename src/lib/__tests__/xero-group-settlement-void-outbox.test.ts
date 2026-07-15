import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settlementFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  startOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBookingSettlement: { findUnique: mocks.settlementFindUnique },
    xeroSyncOperation: { findFirst: mocks.operationFindFirst },
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
  startXeroSyncOperation: mocks.startOperation,
}));

import { enqueueXeroGroupSettlementInvoiceVoidOperation } from "@/lib/xero-group-settlement-void-outbox";

describe("enqueueXeroGroupSettlementInvoiceVoidOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      xeroInvoiceId: "inv-1",
      groupBooking: { status: "CANCELLED" },
    });
    mocks.operationFindFirst.mockResolvedValue(null);
    mocks.startOperation.mockResolvedValue({ id: "void-op-1" });
  });

  it("creates a replayable UPDATE operation with a stable invoice-specific key", async () => {
    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toEqual({
      queueOperationId: "void-op-1",
      message: "Xero group invoice VOID queued for background processing.",
    });

    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "INVOICE",
        operationType: "UPDATE",
        localModel: "GroupBookingSettlement",
        localId: "settle-1",
        status: "PENDING",
        correlationKey:
          "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle-1",
        },
      })
    );
  });

  it("returns the active winner instead of minting duplicate retry debt", async () => {
    mocks.operationFindFirst.mockResolvedValue({ id: "void-op-existing" });

    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toEqual({
      queueOperationId: "void-op-existing",
      message: "Xero group invoice VOID is already queued.",
    });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });

  it("queues nothing without both durable CANCELLED and a persisted invoice", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce({
        id: "settle-1",
        xeroInvoiceId: "inv-1",
        groupBooking: { status: "OPEN" },
      })
      .mockResolvedValueOnce({
        id: "settle-1",
        xeroInvoiceId: null,
        groupBooking: { status: "CANCELLED" },
      });

    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toMatchObject({ queueOperationId: null });
    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toMatchObject({ queueOperationId: null });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });
});
