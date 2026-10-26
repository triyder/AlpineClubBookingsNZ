import { describe, expect, it } from "vitest";
import { observeInvoicePayables } from "@/lib/xero-invoice-payable-observation";

const stamp = "2026-07-01T00:00:00.000Z";
const invoice = { InvoiceID: "one", InvoiceNumber: "INV-123", Type: "ACCREC", CurrencyCode: "NZD", Status: "AUTHORISED", AmountDue: 12.34, Reference: "Supplementary" };
const observe = (changes: Record<string, unknown> = {}) => observeInvoicePayables({ Invoices: [{ ...invoice, ...changes }] }, ["one"], "NZD", stamp)[0];

describe("issued invoice observations (INV-MONEY-001/003)", () => {
  it("shows remaining provider due rather than a total/payment/credit calculation", () => {
    expect(observe({ Total: 100, AmountPaid: 80, AmountCredited: 7.66 })).toEqual({ kind: "payable", invoiceId: "one", invoiceNumber: "INV-123", reference: "Supplementary", dueCents: 1234, observedAt: stamp });
  });
  it.each(["AUTHORISED", "PAID"])("settles only explicit raw zero on %s", (Status) => {
    expect(observe({ Status, AmountDue: 0 })?.kind).toBe("settled");
  });
  it.each([0.0000005, 0.001, -0.0000001, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER, null, "0", undefined])("refuses ambiguous due %s", (AmountDue) => {
    expect(observe({ AmountDue })?.kind).toBe("unknown");
  });
  it.each([
    { Status: "PAID", AmountDue: 1 }, { Status: "DRAFT", AmountDue: 0 }, { Status: "SUBMITTED" },
    { CurrencyCode: "USD" }, { Type: "ACCPAY" }, { InvoiceNumber: null },
  ])("refuses contradictory identity/status/currency %j", (changes) => expect(observe(changes)?.kind).toBe("unknown"));
  it.each(["VOIDED", "DELETED"])("retires %s without claiming a forgiven balance", (Status) => expect(observe({ Status })?.kind).toBe("retired"));
  it("requires coverage and refuses unrelated/duplicate rows", () => {
    expect(observeInvoicePayables({ Invoices: [invoice] }, ["one", "two"], "NZD", stamp).map((row) => row.kind)).toEqual(["payable", "unknown"]);
    for (const Invoices of [[invoice, invoice], [invoice, { ...invoice, InvoiceID: "other" }]]) {
      expect(observeInvoicePayables({ Invoices }, ["one"], "NZD", stamp)[0]?.kind).toBe("unknown");
    }
    expect(observeInvoicePayables({ invoices: [invoice] }, ["one"], "NZD", stamp)[0]?.kind).toBe("unknown");
  });
});
