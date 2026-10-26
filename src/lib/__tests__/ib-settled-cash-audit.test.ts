import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  auditIbSettledCash,
  formatIbSettledCashReport,
  recordedInvoiceCash,
} from "@/lib/ib-settled-cash-audit";

/**
 * #3979 (`INV-PAY-125`): the read-only report of settled bank-transfer receipts
 * whose figure is not the cash Xero recorded. Report only; nothing is written.
 */
function link(localId: string, invoiceId: string, amount: unknown, status = "AUTHORISED") {
  return { localId, xeroObjectType: "PAYMENT", xeroObjectId: `xpay-${localId}-${amount}`, role: "INVOICE_PAYMENT", metadata: { invoiceId, amount, status } };
}

/** The primary-invoice link the inbound sync marks when overpayments or prepayments paid it. */
function allocationsLink(localId: string, invoiceId: string) {
  return { localId, xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "PRIMARY_INVOICE", metadata: { overpaymentOrPrepaymentAllocations: 1 } };
}

describe("recordedInvoiceCash", () => {
  it("sums the invoice's recorded payments, leaving out DELETED ones and other invoices", () => {
    expect(
      recordedInvoiceCash(
        [link("p", "inv", 120), link("p", "inv", 80), link("p", "inv", 50, "DELETED"), link("p", "other", 999)],
        "inv",
      ),
    ).toEqual({ evidence: "payments", cashCents: 20_000 });
  });

  it("says when nothing is recorded, or a figure cannot be read", () => {
    expect(recordedInvoiceCash([], "inv")).toEqual({ evidence: "none", cashCents: null });
    expect(recordedInvoiceCash([link("p", "inv", "120.00")], "inv")).toEqual({ evidence: "unreadable", cashCents: null });
  });
});

describe("auditIbSettledCash", () => {
  function db(payments: unknown[], links: unknown[]) {
    const paymentFindMany = vi.fn().mockResolvedValue(payments);
    const linkFindMany = vi.fn().mockResolvedValue(links);
    return {
      store: { payment: { findMany: paymentFindMany }, xeroObjectLink: { findMany: linkFindMany } } as never,
      paymentFindMany,
      linkFindMany,
    };
  }
  const receipt = (id: string, recordedCents: number, refundedAmountCents = 0, rowRefundedCents = 0) => ({
    id,
    bookingId: `b-${id}`,
    amountCents: recordedCents,
    refundedAmountCents,
    booking: { status: "PAID" },
    transactions: [
      {
        kind: "PRIMARY",
        source: "INTERNET_BANKING",
        status: "SUCCEEDED",
        amountCents: recordedCents,
        refundedAmountCents: rowRefundedCents,
        xeroInvoiceId: `inv-${id}`,
        xeroInvoiceNumber: `INV-${id}`,
      },
    ],
  });

  it("lists a stale receipt, passes one that matches, and lists apart one it cannot judge", async () => {
    const { store, paymentFindMany } = db(
      [receipt("stale", 30_000), receipt("fine", 20_000), receipt("overpaid-by-allocation", 20_000)],
      [link("stale", "inv-stale", 200), link("fine", "inv-fine", 200)],
    );

    const result = await auditIbSettledCash(store);

    expect(result.scanned).toBe(3);
    expect(result.differences).toEqual([
      expect.objectContaining({ paymentId: "stale", recordedCents: 30_000, cashCents: 20_000, evidence: "payments" }),
    ]);
    expect(result.unjudged).toEqual([expect.objectContaining({ paymentId: "overpaid-by-allocation", evidence: "none" })]);
    expect(result.folded).toEqual([]);
    // Only bank-transfer payments not settled by hand, on a captured PRIMARY receipt.
    expect(paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: "INTERNET_BANKING", manuallyMarkedPaidAt: null }),
      }),
    );

    const report = formatIbSettledCashReport(result, CLUB_FORMAT_TEST);
    expect(report).toContain("recorded figure differs from the cash: 1");
    expect(report).toContain("booking b-stale (PAID) payment stale invoice INV-stale: recorded $300.00, cash $200.00");
    expect(report).toContain("no payment recorded locally");
  });

  it("flags a refunded total beyond the rows, and lists an allocation-paid invoice as not judged (#3979 review G)", async () => {
    const { store } = db(
      [receipt("folded", 30_000, 10_000, 0), receipt("allocated", 20_000)],
      [link("folded", "inv-folded", 300), allocationsLink("allocated", "inv-allocated"), link("allocated", "inv-allocated", 150)],
    );

    const result = await auditIbSettledCash(store);

    expect(result.folded).toEqual([
      expect.objectContaining({ paymentId: "folded", refundedAmountCents: 10_000, rowsRefundedCents: 0 }),
    ]);
    expect(result.differences).toEqual([]);
    expect(result.unjudged).toEqual([expect.objectContaining({ paymentId: "allocated", evidence: "allocations" })]);
    const report = formatIbSettledCashReport(result, CLUB_FORMAT_TEST);
    expect(report).toContain("refunded $100.00, rows record $0.00");
    expect(report).toContain("paid by an applied overpayment or prepayment");
    expect(report).toContain("Correct a receipt and the payment's refunded total TOGETHER");
    expect(report).toContain("the owner or a developer");
  });

  it("reads no links when there is nothing to judge", async () => {
    const { store, linkFindMany } = db([], []);
    expect(await auditIbSettledCash(store)).toEqual({ scanned: 0, differences: [], folded: [], unjudged: [] });
    expect(linkFindMany).not.toHaveBeenCalled();
  });
});
