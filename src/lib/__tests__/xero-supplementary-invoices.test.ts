import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
    bookingModification: {
      findUnique: mocks.bookingModificationFindUnique,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.example/invoice/${id}`,
}));

// Keep buildXeroIdempotencyKey / sanitizeForJson real so we can assert the actual
// key the operation records.
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair,
}));

vi.mock("@/lib/xero-invoice-helpers", () => ({
  formatDate: () => "2026-01-01",
}));

import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { lineTotalCents } from "@/lib/__tests__/helpers";

describe("createXeroSupplementaryInvoice idempotency-key discriminator (#1234, L2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: {} },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "200",
      itemCode: undefined,
      codeExplicitlyConfigured: false,
    });
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  });

  it("throws when bookingModificationId is absent instead of collapsing the key to bookingId", async () => {
    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
      })
    ).rejects.toThrow(
      "Supplementary invoice requires a bookingModificationId for a distinct Xero idempotency key"
    );

    // The guard fires before any Xero/DB work.
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("builds the Xero idempotency key from the bookingModificationId discriminator", async () => {
    // Stop the operation right after the key is recorded so we can assert it
    // without driving the full Xero write.
    mocks.retryXeroWriteWithContactRepair.mockRejectedValue(
      new Error("sentinel-stop")
    );

    await expect(
      createXeroSupplementaryInvoice({
        bookingId: "bk1",
        priceDiffCents: 5000,
        changeFeeCents: 2000,
        bookingModificationId: "mod_123",
      })
    ).rejects.toThrow("sentinel-stop");

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.localModel).toBe("BookingModification");
    expect(enqueued.localId).toBe("mod_123");
    // The key is scoped by the modification, not the booking, so two same-amount
    // deltas on one booking never collide.
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_123:supplementary-invoice:5000:2000:v1"
    );
    expect(enqueued.correlationKey).toBe(enqueued.idempotencyKey);
    // The failed operation is marked failed and the error re-thrown.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_x",
      expect.any(Error)
    );
  });
});

// #1356 (F16): a price reduction combined with a larger late-change fee must
// invoice the SIGNED components so the line items sum exactly to the net the
// member paid, and the recorded Xero payment must equal the Stripe capture —
// not the gross fee.
describe("createXeroSupplementaryInvoice mixed-sign components (#1356)", () => {
  const createPayments = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "bk1",
      memberId: "mem1",
      payment: { xeroInvoiceId: "inv_orig" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    createPayments.mockResolvedValue({
      body: { payments: [{ paymentID: "pay_1" }] },
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { createPayments } },
      tenantId: "tenant_1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact_1");
    // Key-aware mapping: give-backs post to the hutFeeRefunds mapping (owner
    // decision on #1356), income lines to hutFeesIncome.
    mocks.getResolvedAccountMapping.mockImplementation(async (key: string) =>
      key === "hutFeeRefunds"
        ? { code: "201", itemCode: undefined, codeExplicitlyConfigured: true }
        : { code: "200", itemCode: undefined, codeExplicitlyConfigured: false }
    );
    mocks.getAccountMapping.mockResolvedValue("606");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_x" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    // createInvoices goes through the contact-repair wrapper; createPayments
    // calls callXeroApi directly, so run the thunk for real.
    mocks.retryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv_supp", invoiceNumber: "INV-0042" }] },
    });
    mocks.callXeroApi.mockImplementation((fn: () => unknown) => fn());
  });

  it("bills the signed net: negative price line + fee line, payment equals the Stripe capture", async () => {
    const invoiceId = await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_mixed",
    });

    expect(invoiceId).toBe("inv_supp");

    // The queued operation's invoice carries BOTH signed component lines,
    // summing exactly to the +500 net charge.
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    const lines = enqueued.requestPayload.invoices[0].lineItems;
    expect(lines).toHaveLength(2);
    expect(lines[0].description).toContain("price adjustment");
    expect(lines[0].unitAmount).toBe(-5);
    // The give-back line posts to the hutFeeRefunds mapping; the fee stays on
    // hutFeesIncome (clubs may map both to one code to collapse the split).
    expect(lines[0].accountCode).toBe("201");
    expect(lines[1].description).toContain("change fee");
    expect(lines[1].unitAmount).toBe(10);
    expect(lines[1].accountCode).toBe("200");
    expect(lineTotalCents(lines)).toBe(500);
    // The idempotency key carries the signed component, not a clamped zero.
    expect(enqueued.idempotencyKey).toBe(
      "booking-mod:mod_mixed:supplementary-invoice:-500:1000:v1"
    );

    // The recorded Xero payment is the 500-cent net Stripe captured — never
    // the 1000-cent gross fee.
    expect(createPayments).toHaveBeenCalledTimes(1);
    const [tenantId, paymentBody, , paymentIdempotencyKey] =
      createPayments.mock.calls[0];
    expect(tenantId).toBe("tenant_1");
    expect(paymentBody.payments[0].amount).toBe(5);
    expect(paymentIdempotencyKey).toBe(
      "booking-mod:mod_mixed:supplementary-payment:500:v1"
    );

    // The payment link metadata mirrors the net for repair-pass evidence.
    const completion = mocks.completeXeroSyncOperation.mock.calls[0][1];
    const paymentLink = completion.extraLinks.find(
      (link: { role: string }) => link.role === "SUPPLEMENTARY_INVOICE_PAYMENT"
    );
    expect(paymentLink.metadata).toEqual({
      invoiceId: "inv_supp",
      amountCents: 500,
    });
  });

  it("completes as skipped without provider calls when the net is not positive", async () => {
    const invoiceId = await createXeroSupplementaryInvoice({
      bookingId: "bk1",
      priceDiffCents: -1500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_negative_net",
      syncOperationId: "op_waiting",
    });

    expect(invoiceId).toBeNull();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith("op_waiting", {
      responsePayload: {
        skipped: true,
        reason: expect.stringContaining("net amount is not positive"),
      },
    });
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(createPayments).not.toHaveBeenCalled();
  });
});
