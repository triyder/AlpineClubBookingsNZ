import { describe, expect, it } from "vitest";
import {
  deriveIbAppliedCreditStrandFinding,
  deriveIbHoldClearingFinding,
  type IbAppliedCreditStrandRow,
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

function makeStrandRow(
  overrides: Partial<IbAppliedCreditStrandRow> = {},
): IbAppliedCreditStrandRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    bookingStatus: "PAYMENT_PENDING",
    paymentStatus: "PENDING",
    amountCents: 10000,
    creditAppliedCents: 3000,
    finalPriceCents: 10000,
    ledgerAppliedCents: 3000,
    ...overrides,
  };
}

describe("deriveIbAppliedCreditStrandFinding (#1620 enumeration)", () => {
  it("returns null when the booking carries no applied credit", () => {
    expect(
      deriveIbAppliedCreditStrandFinding(
        makeStrandRow({ ledgerAppliedCents: 0, creditAppliedCents: 0 }),
      ),
    ).toBeNull();
  });

  it("flags a not-yet-paid IB booking as a PENDING (unrealized) strand", () => {
    const finding = deriveIbAppliedCreditStrandFinding(makeStrandRow());
    expect(finding).not.toBeNull();
    expect(finding?.realized).toBe(false);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("flags a paid IB booking as a REALIZED double-pay", () => {
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({ paymentStatus: "SUCCEEDED", bookingStatus: "PAID" }),
    );
    expect(finding?.realized).toBe(true);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("surfaces the stale mirror on a switched (card-origin) payment", () => {
    // Switch overwrote amountCents → finalPrice and never set creditAppliedCents,
    // yet the BOOKING_APPLIED ledger consumed 3000. Mirror is stale by 3000; the
    // internal payment invariant (amount + credit − final) still nets to 0.
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({
        creditAppliedCents: 0,
        amountCents: 10000,
        ledgerAppliedCents: 3000,
      }),
    );
    expect(finding?.mirrorLedgerMismatchCents).toBe(3000);
    expect(finding?.mirrorInvariantDeltaCents).toBe(0);
    expect(finding?.strandExposureCents).toBe(3000);
  });

  it("shows a consistent mirror on a create-time IB booking", () => {
    // amountCents = effective (7000), creditApplied mirror = ledger = 3000.
    const finding = deriveIbAppliedCreditStrandFinding(
      makeStrandRow({ amountCents: 7000, creditAppliedCents: 3000 }),
    );
    expect(finding?.mirrorLedgerMismatchCents).toBe(0);
    expect(finding?.mirrorInvariantDeltaCents).toBe(0);
  });
});
