import { describe, expect, it } from "vitest";
import { calculateGuestRemovalPaymentImpact } from "@/lib/booking-guest-removal-payment";

describe("booking-guest-removal-service", () => {
  it("refunds successful Stripe payments and Xero invoices for price decreases", () => {
    expect(
      calculateGuestRemovalPaymentImpact({
        bookingStatus: "PAID",
        paymentStatus: "SUCCEEDED",
        hasXeroInvoice: true,
        priceDiffCents: -3500,
        hasPaymentRecord: true,
      })
    ).toEqual({
      hasSucceededPayment: true,
      hasIssuedXeroInvoice: true,
      refundAmountCents: 3500,
      xeroRefundAmountCents: 3500,
    });
  });

  it("does not create refund amounts for pending bookings or price increases", () => {
    expect(
      calculateGuestRemovalPaymentImpact({
        bookingStatus: "PENDING",
        paymentStatus: "SUCCEEDED",
        hasXeroInvoice: true,
        priceDiffCents: -3500,
        hasPaymentRecord: true,
      }).refundAmountCents
    ).toBe(0);

    expect(
      calculateGuestRemovalPaymentImpact({
        bookingStatus: "PAID",
        paymentStatus: "SUCCEEDED",
        hasXeroInvoice: true,
        priceDiffCents: 1200,
        hasPaymentRecord: true,
      })
    ).toMatchObject({
      refundAmountCents: 0,
      xeroRefundAmountCents: 0,
    });
  });

  it("keeps Xero refund impact even when no Stripe payment record exists", () => {
    expect(
      calculateGuestRemovalPaymentImpact({
        bookingStatus: "CONFIRMED",
        paymentStatus: null,
        hasXeroInvoice: true,
        priceDiffCents: -2500,
        hasPaymentRecord: false,
      })
    ).toEqual({
      hasSucceededPayment: false,
      hasIssuedXeroInvoice: true,
      refundAmountCents: 0,
      xeroRefundAmountCents: 2500,
    });
  });
});
