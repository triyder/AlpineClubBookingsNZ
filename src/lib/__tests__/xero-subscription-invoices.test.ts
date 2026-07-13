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
    total: 120,
    lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }],
    ...overrides,
  };
}

describe("Xero membership subscription invoice adoption", () => {
  const snapshot = { contactId: "contact-1", amountCents: 12_000, accountCode: "203", reference: "MEMSUB-reference" };

  it("adopts only an exact reference, recipient, GST-inclusive amount, account and ACCREC match", () => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...snapshot })).toBe(true);
  });

  it.each([
    ["amount mismatch", invoice({ total: 119.99 })],
    ["recipient mismatch", invoice({ contact: { contactID: "other" } })],
    ["account mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "200" }] })],
    ["GST treatment mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "NONE" }] })],
    ["reference mismatch", invoice({ reference: "manual-reference" })],
    ["draft invoice", invoice({ status: Invoice.StatusEnum.DRAFT })],
    ["submitted invoice", invoice({ status: Invoice.StatusEnum.SUBMITTED })],
    ["paid invoice", invoice({ status: Invoice.StatusEnum.PAID })],
    ["voided invoice", invoice({ status: Invoice.StatusEnum.VOIDED })],
  ])("rejects %s without provider correction", (_label, providerInvoice) => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: providerInvoice, ...snapshot })).toBe(false);
  });
});
