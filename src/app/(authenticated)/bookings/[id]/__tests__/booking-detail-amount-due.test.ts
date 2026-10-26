import { describe, expect, it } from "vitest";

import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";
import { bookingAmountOwedCents } from "@/lib/booking-payment-state";

/**
 * #3750 (#3955 review F8, `INV-PAY-119`): a change fee recorded on an unpaid
 * booking's payment is owed with the price, so the pay card shows it as its
 * own row and charges — and says — the total the rows add up to.
 *
 * #3991: the applied credit is the page's one ledger read (`amountOwed`), handed
 * in; the payment row's mirror column is set to a different figure throughout,
 * so a card that read the column would show it.
 */
function resolve(
  payment: { changeFeeCents: number; creditAppliedCents: number },
  options: { finalPriceCents?: number; modules?: Record<string, boolean> } = {},
) {
  const booking = {
    status: "PAYMENT_PENDING",
    // #3372 (composed with #3924): the loader selects these for the retained
    // line's Net Collected rule (`getNetCollectedCashParts`).
    deletedAt: null,
    manualRefundTasks: [],
    finalPriceCents: options.finalPriceCents ?? 20000,
    organiserSettled: false,
    creditsFromCancellation: [],
    refundRequests: [],
    parentBooking: null,
    payment: {
      id: "payment-1",
      status: "PENDING",
      source: "STRIPE",
      amountCents: 0,
      refundedAmountCents: 0,
      _count: { transactions: 0 },
      recoveryOperations: [],
      refunds: [],
      manualRefundTasks: [],
      changeFeeCents: payment.changeFeeCents,
      creditAppliedCents: payment.creditAppliedCents + 999,
    },
  };
  const owedCents = bookingAmountOwedCents({
    finalPriceCents: booking.finalPriceCents,
    changeFeeCents: payment.changeFeeCents,
    appliedCreditCents: payment.creditAppliedCents,
  });
  const amountOwed = {
    owedCents,
    dueCents: Math.max(0, owedCents),
    appliedCreditCents: payment.creditAppliedCents,
  };
  return resolveBookingDetailPayment({
    booking: booking as never,
    modules: (options.modules ?? {}) as never,
    viewer: { canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false, canSeeOwnerCredit: true } as never,
    access: { isDeleted: false } as never,
    party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
    amountOwed,
  });
}

describe("booking page amount due with a recorded change fee (#3955 F8)", () => {
  it("shows the fee as its own row and charges price plus fee", () => {
    const payment = resolve({ changeFeeCents: 2500, creditAppliedCents: 0 });
    expect(payment.showAmountBreakdown).toBe(true);
    expect(payment.changeFeeOwedCents).toBe(2500);
    expect(payment.cardAmountDueCents).toBe(22500);
  });

  it("nets applied credit off price plus fee, so the rows add up", () => {
    const payment = resolve({ changeFeeCents: 2500, creditAppliedCents: 5000 });
    expect(payment.showCreditApplied).toBe(true);
    // 20000 + 2500 - 5000
    expect(payment.cardAmountDueCents).toBe(17500);
    expect(payment.amountDueAfterCreditCents).toBe(17500);
  });

  it("#4357: a $0 booking still owing a recorded change fee can switch to Internet Banking; one owing nothing cannot", () => {
    const modules = { xeroIntegration: true, internetBankingPayments: true };
    expect(resolve({ changeFeeCents: 2500, creditAppliedCents: 0 }, { finalPriceCents: 0, modules }).canSwitchToInternetBanking).toBe(true);
    expect(resolve({ changeFeeCents: 0, creditAppliedCents: 0 }, { finalPriceCents: 0, modules }).canSwitchToInternetBanking).toBe(false);
  });

  it("CONTROL: with no fee and no credit there is no breakdown and the price is due", () => {
    const payment = resolve({ changeFeeCents: 0, creditAppliedCents: 0 });
    expect(payment.showAmountBreakdown).toBe(false);
    expect(payment.cardAmountDueCents).toBe(20000);
  });
});
