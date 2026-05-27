export function calculateGuestRemovalPaymentImpact({
  bookingStatus,
  paymentStatus,
  hasXeroInvoice,
  priceDiffCents,
  hasPaymentRecord,
}: {
  bookingStatus: string;
  paymentStatus: string | null;
  hasXeroInvoice: boolean;
  priceDiffCents: number;
  hasPaymentRecord: boolean;
}) {
  const isSettledStatus = ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(bookingStatus);
  const hasSucceededPayment = isSettledStatus && paymentStatus === "SUCCEEDED";
  const hasIssuedXeroInvoice = isSettledStatus && hasXeroInvoice;
  const isPriceDecrease = priceDiffCents < 0;

  return {
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    refundAmountCents:
      hasSucceededPayment && isPriceDecrease && hasPaymentRecord
        ? Math.abs(priceDiffCents)
        : 0,
    xeroRefundAmountCents:
      hasIssuedXeroInvoice && isPriceDecrease ? Math.abs(priceDiffCents) : 0,
  };
}
