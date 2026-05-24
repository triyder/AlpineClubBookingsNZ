import { describe, expect, it } from "vitest";
import { classifyXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";

describe("classifyXeroBookingEditSettlement", () => {
  it("waits for confirmed additional Stripe payment before supplementary invoice payment recording", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      datesChanged: true,
      requiresAdditionalStripePayment: true,
      additionalPaymentIntentId: "pi_additional",
    });

    expect(decision.financialAction).toEqual({
      type: "supplementary-invoice",
      priceDiffCents: 4500,
      changeFeeCents: 500,
      recordPayment: true,
      waitForPaymentIntentId: "pi_additional",
      reason: expect.stringContaining("after the additional Stripe payment succeeds"),
    });
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "skip",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
    });
  });

  it("creates an unpaid supplementary invoice for invoice-backed unpaid increases", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: 3000,
      datesChanged: false,
    });

    expect(decision.financialAction).toEqual({
      type: "supplementary-invoice",
      priceDiffCents: 3000,
      changeFeeCents: 0,
      recordPayment: false,
      waitForPaymentIntentId: null,
      reason: expect.stringContaining("unpaid supplementary invoice"),
    });
    expect(decision.primaryInvoiceUpdateAction.type).toBe("none");
  });

  it("uses modification credit notes for negative deltas", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "SUCCEEDED",
      priceDiffCents: -2500,
      changeFeeCents: 500,
    });

    expect(decision.financialAction).toEqual({
      type: "modification-credit-note",
      refundAmountCents: 2000,
      reason: expect.stringContaining("modification credit note"),
    });
  });

  it("allows safe primary narration updates for unpaid invoice date-only changes", () => {
    const decision = classifyXeroBookingEditSettlement({
      hasIssuedXeroInvoice: true,
      originalPaymentStatus: "PENDING",
      priceDiffCents: 0,
      datesChanged: true,
    });

    expect(decision.financialAction.type).toBe("none");
    expect(decision.primaryInvoiceUpdateAction).toEqual({
      type: "queue",
      reason: expect.stringContaining("safe primary invoice"),
    });
  });
});
