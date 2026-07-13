import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";

const mocks = vi.hoisted(() => ({
  chargeFind: vi.fn(),
  chargeUpdate: vi.fn(),
  memberSubscriptionUpdateMany: vi.fn(),
  linkUpsert: vi.fn(),
  transaction: vi.fn(),
  getInvoices: vi.fn(),
  createInvoices: vi.fn(),
  emailInvoice: vi.fn(),
  complete: vi.fn(),
  findContact: vi.fn(),
  events: [] as string[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionCharge: { findUnique: mocks.chargeFind, update: mocks.chargeUpdate },
    memberSubscription: { updateMany: mocks.memberSubscriptionUpdateMany },
    xeroObjectLink: { upsert: mocks.linkUpsert },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    tenantId: "tenant-1",
    xero: { accountingApi: {
      getInvoices: mocks.getInvoices,
      createInvoices: mocks.createInvoices,
      emailInvoice: mocks.emailInvoice,
    } },
  }),
  callXeroApi: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/xero-contacts", () => ({ findOrCreateXeroContact: mocks.findContact }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
  completeXeroSyncOperation: mocks.complete,
  startXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";

function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: "charge-1",
    billingBasis: "PER_MEMBER",
    recipientMemberId: "member-1",
    xeroAccountCode: "203",
    xeroItemCode: "SUB",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroInvoiceAdopted: false,
    invoicePersistedAt: null,
    invoiceReference: "MEMSUB-charge-1",
    chargedAmountCents: 12_000,
    membershipTypeName: "Full",
    seasonYear: 2026,
    coveredMonths: 12,
    dueDays: 30,
    coverage: [{ subscription: { id: "subscription-1" } }],
    ...overrides,
  };
}

function providerInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: "invoice-1",
    invoiceNumber: "INV-1",
    type: Invoice.TypeEnum.ACCREC,
    status: Invoice.StatusEnum.AUTHORISED,
    reference: "MEMSUB-charge-1",
    contact: { contactID: "contact-1" },
    lineAmountTypes: LineAmountTypes.Inclusive,
    date: "2026-07-01",
    dueDate: "2026-07-31",
    total: 120,
    lineItems: [{ accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2", quantity: 1, unitAmount: 120, lineAmount: 120 }],
    ...overrides,
  };
}

describe("subscription invoice delivery behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.findContact.mockResolvedValue("contact-1");
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [] } });
    mocks.createInvoices.mockImplementation(async () => {
      mocks.events.push("create");
      return { body: { invoices: [providerInvoice()] } };
    });
    mocks.emailInvoice.mockImplementation(async () => {
      mocks.events.push("email");
      return { body: {} };
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      mocks.events.push("persist");
      return callback({
        membershipSubscriptionCharge: { update: vi.fn() },
        memberSubscription: { updateMany: mocks.memberSubscriptionUpdateMany },
        xeroObjectLink: { upsert: mocks.linkUpsert },
      });
    });
  });

  it("persists a created invoice before email and retries only email after partial failure", async () => {
    mocks.chargeFind
      .mockResolvedValueOnce(charge())
      .mockResolvedValueOnce(charge({
        xeroInvoiceId: "invoice-1",
        xeroInvoiceNumber: "INV-1",
        invoicePersistedAt: new Date("2026-07-13T00:00:00.000Z"),
      }));
    mocks.emailInvoice.mockRejectedValueOnce(new Error("mail unavailable")).mockResolvedValueOnce({ body: {} });

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperationId: "op-1" });
    expect(mocks.events.slice(0, 2)).toEqual(["create", "persist"]);
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emailInvoice.mock.invocationCallOrder[0]
    );
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "EMAIL_FAILED", lastErrorCode: "EMAIL_FAILED" }),
    }));

    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperationId: "op-2" });
    expect(mocks.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.getInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.emailInvoice).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenLastCalledWith("op-2", expect.objectContaining({ xeroObjectId: "invoice-1" }));
  });

  it("adopts and emails an exact AUTHORISED invoice", async () => {
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [providerInvoice()] } });
    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperationId: "op-1" });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).toHaveBeenCalledWith("tenant-1", "invoice-1", expect.anything(), expect.any(String));
    expect(mocks.events[0]).toBe("persist");
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emailInvoice.mock.invocationCallOrder[0]
    );
  });

  it.each([
    ["mismatched amount", providerInvoice({ total: 119 })],
    ["draft", providerInvoice({ status: Invoice.StatusEnum.DRAFT })],
    ["submitted", providerInvoice({ status: Invoice.StatusEnum.SUBMITTED })],
    ["paid", providerInvoice({ status: Invoice.StatusEnum.PAID })],
  ])("records provider conflict for %s without rewriting or emailing", async (_label, invoice) => {
    mocks.chargeFind.mockResolvedValue(charge());
    mocks.getInvoices.mockResolvedValue({ body: { invoices: [invoice] } });
    await createXeroMembershipSubscriptionInvoice({ chargeId: "charge-1", syncOperationId: "op-1" });
    expect(mocks.createInvoices).not.toHaveBeenCalled();
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.chargeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CONFLICT", lastErrorCode: "PROVIDER_MISMATCH" }),
    }));
  });
});
