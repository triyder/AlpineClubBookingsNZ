import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, GroupBookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const settlementFindUnique = vi.fn();
  const settlementUpdate = vi.fn();
  const tx = {
    $executeRaw: vi.fn(),
    groupBookingSettlement: {
      findUnique: settlementFindUnique,
      update: settlementUpdate,
    },
  };
  const accountingApi = {
    createInvoices: vi.fn(),
    updateInvoice: vi.fn(),
    emailInvoice: vi.fn(),
  };
  return {
    tx,
    settlementFindUnique,
    settlementUpdate,
    accountingApi,
    completeSync: vi.fn(),
    failSync: vi.fn(),
    upsertLink: vi.fn(),
    enqueueVoid: vi.fn(),
    transaction: vi.fn(),
    transactionDepth: 0,
  };
});

vi.mock("xero-node", () => ({
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED", VOIDED: "VOIDED" },
  },
  LineAmountTypes: { Inclusive: "Inclusive" },
  LineItem: class {},
  RequestEmpty: class {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    groupBookingSettlement: {
      update: mocks.settlementUpdate,
      findUnique: mocks.settlementFindUnique,
    },
    booking: { findMany: vi.fn() },
    season: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroSyncOperation: { update: vi.fn() },
  },
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    xero: { accountingApi: mocks.accountingApi },
    tenantId: "tenant-1",
  }),
  callXeroApi: vi.fn(async (callback) => callback()),
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: vi.fn().mockResolvedValue("contact-1"),
  retryXeroWriteWithContactRepair: vi.fn(async ({ currentContactId, run }) =>
    run({ contactId: currentContactId })
  ),
}));

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: vi.fn().mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: true,
  }),
  getHutFeeItemCodeMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/xero-booking-invoices", () => ({
  buildInvoiceLineItems: vi.fn(() => [{ description: "One lodge stay" }]),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
  completeXeroSyncOperation: mocks.completeSync,
  failXeroSyncOperation: mocks.failSync,
  sanitizeForJson: vi.fn((value) => value),
  startXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: mocks.upsertLink,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: vi.fn((id: string) => `https://xero.test/${id}`),
}));

vi.mock("@/lib/pricing", () => ({
  getStayNights: vi.fn(() => [new Date("2026-07-01")]),
}));

vi.mock("@/lib/xero-invoice-helpers", () => ({
  formatDate: vi.fn(() => "2026-07-01"),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation: mocks.enqueueVoid,
}));

import { prisma } from "@/lib/prisma";
import {
  createXeroInvoiceForGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement,
} from "@/lib/xero-group-settlement-invoices";

function settlement(status: GroupBookingStatus) {
  return {
    id: "settle-1",
    createdAt: new Date("2026-06-01"),
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    groupBooking: {
      id: "group-1",
      status,
      organiserMemberId: "member-1",
      organiserBookingId: "organiser-booking-1",
      organiserBooking: { checkIn: new Date("2026-07-01") },
    },
  };
}

function settlementWithInvoice(status: GroupBookingStatus) {
  return {
    ...settlement(status),
    xeroInvoiceId: "inv-existing",
    xeroInvoiceNumber: "INV-EXISTING",
  };
}

describe("createXeroInvoiceForGroupSettlement cancellation fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback) => {
      mocks.transactionDepth += 1;
      try {
        return await callback(mocks.tx);
      } finally {
        mocks.transactionDepth -= 1;
      }
    });
    mocks.settlementUpdate.mockResolvedValue({});
    mocks.enqueueVoid.mockResolvedValue({ queueOperationId: "void-op-1" });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      {
        id: "child-1",
        status: BookingStatus.CONFIRMED,
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-02"),
        guests: [],
      } as never,
    ]);
    mocks.accountingApi.createInvoices.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1" }] },
    });
    mocks.accountingApi.updateInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
    });
  });

  it("does no provider work when cancellation committed before the worker starts", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement(GroupBookingStatus.CANCELLED)
    );

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).not.toHaveBeenCalled();
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: { cancelledBeforeInvoiceCreation: true },
      })
    );
  });

  it("retries durable compensation when a cancelled settlement already has an invoice", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).toHaveBeenCalledWith("settle-1", {
      store: mocks.tx,
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-existing",
      { invoices: [{ invoiceID: "inv-existing", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-existing:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });

  it("voids and suppresses email when cancellation wins while createInvoices is in flight", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: { status: GroupBookingStatus.CANCELLED },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-1",
      { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });

  it("replays the durable VOID handler idempotently with the stable provider key", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );

    await voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
      syncOperationId: "void-op-1",
    });
    await voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
      syncOperationId: "void-op-2",
    });

    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledTimes(2);
    for (const call of mocks.accountingApi.updateInvoice.mock.calls) {
      expect(call[4]).toBe(
        "group-settlement:settle-1:invoice-void-after-cancel:inv-existing:v1"
      );
    }
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-2",
      expect.objectContaining({ status: "SUCCEEDED" })
    );
  });

  it("propagates a durable VOID failure so the outbox retry machinery can re-drive it", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );
    mocks.accountingApi.updateInvoice.mockRejectedValueOnce(
      new Error("Xero unavailable")
    );

    await expect(
      voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
        syncOperationId: "void-op-1",
      })
    ).rejects.toThrow("Xero unavailable");
    expect(mocks.completeSync).not.toHaveBeenCalled();
  });

  it("holds the lifecycle fence for the single bounded invoice email call", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({ groupBooking: { status: GroupBookingStatus.OPEN } })
      .mockResolvedValueOnce({ groupBooking: { status: GroupBookingStatus.OPEN } });
    mocks.accountingApi.emailInvoice.mockImplementation(async () => {
      expect(mocks.transactionDepth).toBe(1);
      return { body: { sent: true } };
    });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBe("inv-1");

    expect(mocks.accountingApi.emailInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueVoid).not.toHaveBeenCalled();
  });

  it("voids durably and suppresses email when cancellation commits after the post-create check", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: { status: GroupBookingStatus.OPEN },
      })
      .mockResolvedValueOnce({
        groupBooking: { status: GroupBookingStatus.CANCELLED },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-1",
      { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).toHaveBeenCalledWith("settle-1", {
      store: mocks.tx,
    });
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });
});
