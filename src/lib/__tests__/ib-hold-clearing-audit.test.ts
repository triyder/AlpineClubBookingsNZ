import { describe, expect, it } from "vitest";
import {
  deriveIbHoldClearingFinding,
  type IbHoldClearingRow,
} from "@/lib/ib-hold-clearing-audit";

function makeRow(overrides: Partial<IbHoldClearingRow> = {}): IbHoldClearingRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    bookingStatus: "CANCELLED",
    // effectivePriceCents: finalPrice (15000) − 2655 applied credit.
    enqueuedClearingCents: 12345,
    changeFeeCents: 0,
    xeroInvoiceId: "inv_1",
    xeroInvoiceNumber: "INV-001",
    xeroRefundCreditNoteId: "cn_1",
    finalPriceCents: 15000,
    xeroAllocatedCreditSumCents: 0,
    ...overrides,
  };
}

describe("deriveIbHoldClearingFinding (#1597 audit sizing)", () => {
  it("flags a credit-carrying invoice cleared at the credit-reduced amount", () => {
    const finding = deriveIbHoldClearingFinding(makeRow());
    expect(finding).not.toBeNull();
    // Expected = full finalPrice (no Xero credit note allocated); actual = the
    // credit-reduced 12345; open delta = the 2655 applied-credit slice.
    expect(finding?.expectedClearingCents).toBe(15000);
    expect(finding?.enqueuedClearingCents).toBe(12345);
    expect(finding?.deltaCents).toBe(2655);
    expect(finding?.invoiceRef).toBe("INV-001");
    expect(finding?.refundNoteIssued).toBe(true);
  });

  it("returns null for a released hold with no issued invoice", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({ xeroInvoiceId: null, xeroInvoiceNumber: null }),
    );
    expect(finding).toBeNull();
  });

  it("returns null for the switch-to-IB shape cleared at full finalPrice", () => {
    // amountCents = finalPrice (no credit reduction): expected == actual, so no
    // under-clear.
    const finding = deriveIbHoldClearingFinding(
      makeRow({ enqueuedClearingCents: 15000 }),
    );
    expect(finding).toBeNull();
  });

  it("subtracts only credit allocated to the invoice as a Xero credit note", () => {
    // A NZ$50 credit note (stored negative) already reduced the invoice's Xero
    // balance to 10000; the note was still sized at 12345, so the invoice is now
    // OVER-cleared — expected (10000) < actual (12345), delta <= 0, no finding.
    const finding = deriveIbHoldClearingFinding(
      makeRow({ xeroAllocatedCreditSumCents: -5000 }),
    );
    expect(finding).toBeNull();
  });

  it("floors expected clearing at zero when Xero credit notes exceed the invoice", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({
        xeroAllocatedCreditSumCents: -20000,
        enqueuedClearingCents: 0,
      }),
    );
    expect(finding).toBeNull();
  });

  it("includes any billed change fee in the expected outstanding", () => {
    const finding = deriveIbHoldClearingFinding(
      makeRow({ changeFeeCents: 1000, enqueuedClearingCents: 12345 }),
    );
    // expected = 15000 + 1000 − 0 = 16000; delta = 16000 − 12345 = 3655.
    expect(finding?.expectedClearingCents).toBe(16000);
    expect(finding?.deltaCents).toBe(3655);
  });
});
