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
    $transaction: vi.fn(async (callback) => callback(mocks.tx)),
    groupBookingSettlement: { update: mocks.settlementUpdate },
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

import { prisma } from "@/lib/prisma";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";

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
    mocks.settlementUpdate.mockResolvedValue({});
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
