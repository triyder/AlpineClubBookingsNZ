import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  createCancellationCredit: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  processWaitlistForDates: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  processRefund: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      // Split-booking cascade (#738) looks for linked provisional children
      // after a successful cancel; none here.
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: {
      update: mocks.paymentUpdate,
    },
    promoRedemption: {
      findUnique: mocks.promoRedemptionFindUnique,
    },
    promoCode: {
      update: vi.fn(),
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: mocks.calculateRefundAmount,
  daysUntilDate: mocks.daysUntilDate,
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: mocks.createCancellationCredit,
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: mocks.enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation:
    mocks.enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: class PartialRefundError extends Error {
    completedRefundCents = 0;
  },
  applyLocalRefundAllocation: mocks.applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed: mocks.markPaymentIntentTransactionFailed,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
}));

import { cancelBooking } from "@/lib/booking-cancel";

describe("cancelBooking credit refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking_1",
      memberId: "member_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_1",
      },
    });
    mocks.prismaTransaction.mockImplementation(async (actions: Array<Promise<unknown>>) =>
      Promise.all(actions)
    );
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.daysUntilDate.mockReturnValue(30);
    mocks.loadCancellationPolicy.mockResolvedValue({
      fullRefundDays: 60,
      partialRefundDays: 14,
      partialRefundPercentage: 50,
      creditRefundPercentage: 100,
    });
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 5000,
      refundPercentage: 50,
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.createCancellationCredit.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.enqueueXeroAccountCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_account_credit_1",
      message: "queued",
    });
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_mod_credit_1",
      message: "queued",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(null);
    mocks.applyLocalRefundAllocation.mockResolvedValue(undefined);
    mocks.markPaymentIntentTransactionFailed.mockResolvedValue(undefined);
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1", paymentIntentId: "pi_1", amountCents: 5000 }],
    });
  });

  it("creates the local credit first, then queues the Xero account-credit note", async () => {
    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 5000,
        refundMethod: "credit",
        creditAmountCents: 5000,
      }),
    });

    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      5000,
      "booking_1"
    );
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 5000,
    });
    expect(mocks.enqueueXeroAccountCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      5000,
      {
        createdByMemberId: "member_1",
      }
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
    expect(
      mocks.createCancellationCredit.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.enqueueXeroAccountCreditNoteOperation.mock.invocationCallOrder[0]
    );
  });

  it("marks unpaid cancelled bookings as failed and clears the Xero invoice with a credit note", async () => {
    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "booking_2",
      memberId: "member_1",
      status: "CONFIRMED",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_2",
        bookingId: "booking_2",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_2",
        xeroInvoiceId: "inv_2",
        additionalPaymentStatus: null,
      },
    });

    const result = await cancelBooking(
      "booking_2",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 0,
      }),
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_2" },
      data: { status: "FAILED" },
    });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "booking_2",
        refundAmountCents: 10000,
      },
      {
        createdByMemberId: "member_1",
      }
    );
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_2");
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_2",
    });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  it("clears only the reduced outstanding balance on an unpaid invoice already credited by a prior reduction (#1015)", async () => {
    // A prior guest removal issued a full-delta modification credit note
    // against the primary invoice (finalPrice 10000 -> 5000) but never
    // reissued it, so payment.amountCents stays at the original 10000 and
    // refundedAmountCents is still 0 until async Xero reconciliation folds in
    // the credit note. Cancelling in that window must clear the true
    // outstanding (finalPrice 5000), not the stale amountCents (10000), or the
    // total credit notes exceed the invoice.
    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "booking_3",
      memberId: "member_1",
      status: "CONFIRMED",
      finalPriceCents: 5000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_3",
        bookingId: "booking_3",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_3",
        xeroInvoiceId: "inv_3",
        additionalPaymentStatus: null,
      },
    });

    const result = await cancelBooking(
      "booking_3",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "booking_3",
        refundAmountCents: 5000,
      },
      {
        createdByMemberId: "member_1",
      }
    );
  });

  it("waits for Stripe cancellation before finalising an unpaid booking cancellation", async () => {
    let releaseCancellation: (() => void) | null = null;

    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "booking_3",
      memberId: "member_1",
      status: "CONFIRMED",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_3",
        bookingId: "booking_3",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_3",
        xeroInvoiceId: null,
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
      },
    });
    mocks.cancelPaymentIntentIfCancellable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCancellation = () => resolve(null);
        })
    );

    const resultPromise = cancelBooking(
      "booking_3",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    await Promise.resolve();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(releaseCancellation).not.toBeNull();

    releaseCancellation?.();
    await resultPromise;

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_3" },
      data: { status: "FAILED" },
    });
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_3",
    });
  });

  it("caps the refundable base at the booking's current value (#1031)", async () => {
    // A prior reduction left the Payment mirror stale: amountCents 30000,
    // refundedAmountCents 0, but the booking is now worth 20000. The refund
    // base must be 20000, not 30000.
    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "booking_5",
      memberId: "member_1",
      status: "PAID",
      finalPriceCents: 20000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_5",
        bookingId: "booking_5",
        amountCents: 30000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_5",
      },
    });
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 20000,
      refundPercentage: 100,
    });

    const result = await cancelBooking(
      "booking_5",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.calculateRefundAmount).toHaveBeenCalledWith(
      20000,
      expect.anything(),
      expect.anything(),
      "card"
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_5", amountCents: 20000 })
    );
  });

  it("cancels outstanding additional payment intents and marks them failed on credit refunds", async () => {
    mocks.bookingFindUnique.mockResolvedValueOnce({
      id: "booking_4",
      memberId: "member_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_4",
        bookingId: "booking_4",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_4",
        additionalPaymentIntentId: "pi_4_additional",
        additionalPaymentStatus: "PENDING",
      },
    });

    await cancelBooking(
      "booking_4",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
      "pi_4_additional"
    );
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_4_additional",
    });
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_4",
      amountCents: 5000,
    });
  });
});
