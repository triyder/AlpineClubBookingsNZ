import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";

const enqueueMocks = vi.hoisted(() => ({
  chargeFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  startOperation: vi.fn(),
  chargeUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionCharge: { findUnique: enqueueMocks.chargeFindUnique, update: enqueueMocks.chargeUpdate },
    xeroSyncOperation: { findFirst: enqueueMocks.operationFindFirst },
  },
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xero-sync")>()),
  startXeroSyncOperation: enqueueMocks.startOperation,
}));

import {
  enqueueMembershipSubscriptionChargeOperation,
  subscriptionInvoiceMatchesSnapshot,
} from "@/lib/xero-subscription-invoices";

describe("enqueueMembershipSubscriptionChargeOperation ignores VOIDED charges (#2147)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueMocks.operationFindFirst.mockResolvedValue(null);
    enqueueMocks.startOperation.mockResolvedValue({ id: "op-1" });
    enqueueMocks.chargeUpdate.mockResolvedValue({});
  });

  it("no-ops a VOIDED charge (RETRY_CHARGE must not re-enqueue it)", async () => {
    enqueueMocks.chargeFindUnique.mockResolvedValue({
      id: "charge-void", status: "VOIDED", billingBasis: "PER_MEMBER", xeroInvoiceId: "xi", emailSentAt: null,
    });
    const result = await enqueueMembershipSubscriptionChargeOperation("charge-void");
    expect(result).toEqual({ queueOperationId: null, message: "No subscription invoice work is required." });
    expect(enqueueMocks.startOperation).not.toHaveBeenCalled();
    expect(enqueueMocks.chargeUpdate).not.toHaveBeenCalled();
  });

  it("still enqueues a QUEUED charge (control)", async () => {
    enqueueMocks.chargeFindUnique.mockResolvedValue({
      id: "charge-live", status: "QUEUED", billingBasis: "PER_MEMBER", xeroInvoiceId: null, emailSentAt: null,
    });
    const result = await enqueueMembershipSubscriptionChargeOperation("charge-live");
    expect(result.queueOperationId).toBe("op-1");
    expect(enqueueMocks.startOperation).toHaveBeenCalledTimes(1);
  });
});

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: "invoice-1",
    type: Invoice.TypeEnum.ACCREC,
    status: Invoice.StatusEnum.AUTHORISED,
    reference: "MEMSUB-reference",
    contact: { contactID: "contact-1" },
    lineAmountTypes: LineAmountTypes.Inclusive,
    date: "2026-07-01",
    dueDate: "2026-07-31",
    total: 120,
    lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" }],
    ...overrides,
  };
}

describe("Xero membership subscription invoice adoption", () => {
  const snapshot = {
    contactId: "contact-1",
    amountCents: 12_000,
    lines: [{ amountCents: 12_000, accountCode: "203", itemCode: "SUB" as string | null }],
    dueDays: 30,
    reference: "MEMSUB-reference",
  };

  it("adopts only an exact reference, recipient, GST-inclusive amount, account and ACCREC match", () => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...snapshot })).toBe(true);
  });

  it.each([
    ["amount mismatch", invoice({ total: 119.99 })],
    ["recipient mismatch", invoice({ contact: { contactID: "other" } })],
    ["account mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "200" }] })],
    ["missing item", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }] })],
    ["wrong item", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", itemCode: "OTHER", taxType: "OUTPUT2" }] })],
    ["due interval drift", invoice({ dueDate: "2026-08-01" })],
    ["GST treatment mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "NONE" }] })],
    ["reference mismatch", invoice({ reference: "manual-reference" })],
    ["draft invoice", invoice({ status: Invoice.StatusEnum.DRAFT })],
    ["submitted invoice", invoice({ status: Invoice.StatusEnum.SUBMITTED })],
    ["paid invoice", invoice({ status: Invoice.StatusEnum.PAID })],
    ["voided invoice", invoice({ status: Invoice.StatusEnum.VOIDED })],
  ])("rejects %s without provider correction", (_label, providerInvoice) => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: providerInvoice, ...snapshot })).toBe(false);
  });

  it("matches null snapshot item only when the provider item is absent or null", () => {
    const noItemSnapshot = { ...snapshot, lines: [{ amountCents: 12_000, accountCode: "203", itemCode: null as string | null }] };
    expect(subscriptionInvoiceMatchesSnapshot({
      invoice: invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }] }),
      ...noItemSnapshot,
    })).toBe(true);
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...noItemSnapshot })).toBe(false);
  });

  describe("multi-line component invoices (#1932, E6)", () => {
    const multi = () => invoice({
      total: 150,
      lineItems: [
        { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" },
        { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
      ],
    });
    const multiSnapshot = {
      contactId: "contact-1",
      amountCents: 15_000,
      lines: [
        { amountCents: 10_000, accountCode: "203", itemCode: "SUB" as string | null },
        { amountCents: 5_000, accountCode: "260", itemCode: null as string | null },
      ],
      dueDays: 30,
      reference: "MEMSUB-reference",
    };

    it("adopts an exact full-line-array match in order", () => {
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: multi(), ...multiSnapshot })).toBe(true);
    });

    it("rejects when a line count differs", () => {
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice({ total: 150 }), ...multiSnapshot })).toBe(false);
    });

    it("rejects when the lines are the same set but out of order", () => {
      const swapped = invoice({
        total: 150,
        lineItems: [
          { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
          { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" },
        ],
      });
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: swapped, ...multiSnapshot })).toBe(false);
    });

    it("rejects when a single line's account differs but the total still foots", () => {
      const drifted = invoice({
        total: 150,
        lineItems: [
          { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "999", itemCode: "SUB", taxType: "OUTPUT2" },
          { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
        ],
      });
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: drifted, ...multiSnapshot })).toBe(false);
    });
  });
});
