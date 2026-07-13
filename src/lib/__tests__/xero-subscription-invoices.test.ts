import { describe, expect, it } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";
import { subscriptionInvoiceMatchesSnapshot } from "@/lib/xero-subscription-invoices";

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
  const snapshot = { contactId: "contact-1", amountCents: 12_000, accountCode: "203", itemCode: "SUB", dueDays: 30, reference: "MEMSUB-reference" };

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
    const noItemSnapshot = { ...snapshot, itemCode: null };
    expect(subscriptionInvoiceMatchesSnapshot({
      invoice: invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }] }),
      ...noItemSnapshot,
    })).toBe(true);
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...noItemSnapshot })).toBe(false);
  });
});
