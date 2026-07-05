import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // A PartialRefundError stand-in that actually carries completedRefundCents
  // so the card retry test can freeze amount=50, completed=40 -> remainder 10.
  class MockPartialRefundError extends Error {
    completedRefundCents: number;
    constructor(completedRefundCents: number) {
      super("partial refund");
      this.name = "PartialRefundError";
      this.completedRefundCents = completedRefundCents;
    }
  }
  return {
  PartialRefundError: MockPartialRefundError,
  bookingFindUnique: vi.fn(),
  // The tx1 single-flight re-read under the advisory lock (#1160). Kept
  // separate from the outer read so a test can make the re-read see a
  // CANCELLED booking (the race loser) while the outer read still saw PAID.
  txBookingFindUnique: vi.fn(),
  txExecuteRaw: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingRequestUpdateMany: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  calculateRefundAmount: vi.fn(),
  calculateAppliedCreditRestore: vi.fn(),
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
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  processRefund: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueBookingCancellationRefundRecovery: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      // Split-booking cascade (#738) looks for linked provisional children
      // after a successful cancel; none here.
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingRequest: {
      updateMany: mocks.bookingRequestUpdateMany,
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
  calculateAppliedCreditRestore: mocks.calculateAppliedCreditRestore,
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
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
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
  PartialRefundError: mocks.PartialRefundError,
  applyLocalRefundAllocation: mocks.applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed: mocks.markPaymentIntentTransactionFailed,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueBookingCancellationRefundRecovery:
    mocks.enqueueBookingCancellationRefundRecovery,
}));

import { cancelBooking } from "@/lib/booking-cancel";

describe("cancelBooking credit refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const defaultPaidBooking = {
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
    };
    mocks.bookingFindUnique.mockResolvedValue(defaultPaidBooking);
    // By default the tx1 re-read sees the same still-cancellable, still-paid
    // booking. Tests that model a lost claim override this to CANCELLED.
    mocks.txBookingFindUnique.mockResolvedValue(defaultPaidBooking);
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    // The cancel service uses two $transaction shapes: the callback form for
    // the paid single-flight critical section (#1160) and the array form for
    // the pre-payment branches. Support both.
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            booking: {
              findUnique: mocks.txBookingFindUnique,
              update: mocks.bookingUpdate,
            },
            payment: {
              update: mocks.paymentUpdate,
            },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
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
    // Tiered applied-credit restore (#1164). Default 0; the credit-restore test
    // overrides it to a deterministic tiered amount.
    mocks.calculateAppliedCreditRestore.mockReturnValue({
      creditRestoredCents: 0,
      creditRestorePercentage: 50,
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
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_credit_1",
      message: "queued",
    });
    mocks.enqueueBookingCancellationRefundRecovery.mockResolvedValue({
      id: "recovery_op_1",
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

    // Credit ledger writes now run inside the tx1 claim: the writers receive
    // the transaction client (#1160).
    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      5000,
      "booking_1",
      undefined,
      expect.anything()
    );
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 5000,
      store: expect.anything(),
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

    (releaseCancellation as (() => void) | null)?.();
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
    const booking5 = {
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
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking5);
    // The frozen refund plan reads from the tx1 re-read, so it must see the
    // same stale-mirror booking.
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking5);
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
    const booking4 = {
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
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking4);
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking4);

    await cancelBooking(
      "booking_4",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    // The Stripe cancel of the additional intent now runs best-effort in
    // Phase 2 via cancelOutstandingPaymentIntents (which marks the tx row
    // failed without a store), after tx1 already flipped the payment-level
    // additionalPaymentStatus to FAILED.
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
      "pi_4_additional"
    );
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_4_additional",
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_4" },
      data: { additionalPaymentStatus: "FAILED" },
    });
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_4",
      amountCents: 5000,
      store: expect.anything(),
    });
  });

  it("returns 409 and moves no money when the tx1 re-read finds the booking already cancelled (#1160)", async () => {
    // The outer read still saw PAID (it passes the initial guards), but under
    // the advisory lock the single-flight re-read sees CANCELLED: a concurrent
    // cancel already claimed it. The loser must be a pure no-op.
    mocks.txBookingFindUnique.mockResolvedValueOnce({
      id: "booking_1",
      memberId: "member_1",
      status: "CANCELLED",
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
        creditAppliedCents: 5000,
        stripePaymentIntentId: "pi_1",
      },
    });

    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(409);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.createCancellationCredit).not.toHaveBeenCalled();
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    // No status flip, no downstream child/group cleanup.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("keeps the booking CANCELLED and enqueues only the remainder when a card refund fails partway (#1160)", async () => {
    // Frozen refund = 50c; Stripe refunded and recorded 40c before failing.
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 50,
      refundPercentage: 100,
    });
    mocks.refundPaymentTransactions.mockRejectedValueOnce(
      new mocks.PartialRefundError(40)
    );

    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    // The claim stands; the failure does not rethrow.
    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 50,
        refundMethod: "card",
      }),
    });
    expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      amountCents: 10,
    });
    // Status flipped exactly once, inside tx1.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_1" },
      data: { status: "CANCELLED" },
    });
  });

  it("does not restore credit twice when a retry loses the single-flight claim (#1160)", async () => {
    const bookingWithCredit = {
      id: "booking_credit",
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
        id: "payment_credit",
        bookingId: "booking_credit",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 3000,
        stripePaymentIntentId: "pi_credit",
      },
    };
    // Both attempts pass the outer guard on a stale PAID read.
    mocks.bookingFindUnique.mockResolvedValue(bookingWithCredit);
    // First attempt claims (re-read PAID); the retry's re-read sees CANCELLED.
    mocks.txBookingFindUnique
      .mockResolvedValueOnce(bookingWithCredit)
      .mockResolvedValueOnce({ ...bookingWithCredit, status: "CANCELLED" });
    // The 3000 applied credit is tiered to 1500 (#1164); restoreCreditFromBooking
    // receives that tiered amount as its 4th (override) arg.
    mocks.calculateAppliedCreditRestore.mockReturnValue({
      creditRestoredCents: 1500,
      creditRestorePercentage: 50,
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(1500);

    const first = await cancelBooking(
      "booking_credit",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );
    const second = await cancelBooking(
      "booking_credit",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    // The restore now passes the tiered override (#1164) as the 4th arg.
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "member_1",
      "booking_credit",
      expect.anything(),
      1500
    );
    // The tiered restored amount is threaded to the cancellation email (7th arg)
    // so the member sees the policy-adjusted restore, not the full applied sum.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "member@example.com",
      "Alice",
      expect.anything(),
      expect.anything(),
      5000,
      "card",
      1500
    );
  });

  it("cancels a paid booking with a 0% refund policy inside the single-flight claim (#1160)", async () => {
    // The zero-refund branch's status flip now happens in tx1; no money
    // movement remains in Phase 2.
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 0,
      refundPercentage: 0,
    });

    const result = await cancelBooking(
      "booking_1",
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
        refundPercentage: 0,
      }),
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_1" },
      data: { status: "CANCELLED" },
    });
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authorization widening + refund parity (issue #1313, owner-approved option
  // A2). A Booking Officer (bookings:edit) may cancel a booking they do not own
  // with the SAME authority as a Full Admin. `hasBookingsEditAccess` widens ONLY
  // the authorization gate; the refund plan keys off booking state + policy
  // tier, never the actor role, so an officer cancel and a Full-Admin cancel are
  // byte-identical in money, Stripe path, email, and audit (only the actor id
  // differs). These inherit the outer beforeEach (a PAID booking owned by
  // "member_1" with a fixed 50% / 5000c card refund plan).
  // -------------------------------------------------------------------------
  describe("authorization widening + refund parity (issue #1313 option A2)", () => {
    it("lets a non-owner Booking Officer (bookings:edit) cancel and refund exactly as the owner does", async () => {
      const result = await cancelBooking(
        "booking_1",
        "officer-1", // NOT the owner (member_1)
        "USER", // an officer keeps their honest legacy authorization role
        "127.0.0.1",
        "card",
        { hasBookingsEditAccess: true }
      );

      expect(result).toMatchObject({
        status: 200,
        data: expect.objectContaining({
          success: true,
          refundAmountCents: 5000,
          refundMethod: "card",
        }),
      });
      // Refund lands on the OWNER's original payment (payment_1), actor-independent.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 5000 })
      );
    });

    it("forbids a non-owner actor without bookings:edit (a plain member AND a read-only admin both resolve to role USER + flag false)", async () => {
      const result = await cancelBooking(
        "booking_1",
        "intruder-1",
        "USER",
        "127.0.0.1",
        "card"
        // No hasBookingsEditAccess: the member-facing route passes `false` for a
        // plain member and for a read-only admin (bookings:view, not :edit).
      );

      expect(result).toEqual({ status: 403, error: "Forbidden" });
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    });

    it("leaves the booking owner's cancel path unchanged", async () => {
      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "USER",
        "127.0.0.1",
        "card"
      );
      expect(result.status).toBe(200);
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 5000 })
      );
    });

    it("leaves the Full-Admin (role ADMIN) cancel path unchanged", async () => {
      const result = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card"
      );
      expect(result.status).toBe(200);
    });

    it("produces byte-identical refund, cancellation email, and audit for an officer cancel vs a Full-Admin cancel (only the actor id differs)", async () => {
      const officer = await cancelBooking(
        "booking_1",
        "officer-1",
        "USER",
        "127.0.0.1",
        "card",
        { hasBookingsEditAccess: true }
      );
      const admin = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card"
      );

      // Same money outcome (the whole success payload matches).
      expect(officer.status).toBe(200);
      expect(admin.status).toBe(200);
      if (officer.status !== 200 || admin.status !== 200) {
        throw new Error("expected both cancels to succeed");
      }
      expect(officer.data).toEqual(admin.data);
      expect(officer.data.refundAmountCents).toBe(5000);

      // Same Stripe refund: same amount, same destination payment (payment_1).
      const refundCalls = mocks.refundPaymentTransactions.mock.calls;
      expect(refundCalls).toHaveLength(2);
      expect(refundCalls[0][0]).toMatchObject({
        paymentId: "payment_1",
        amountCents: 5000,
      });
      expect(refundCalls[1][0]).toMatchObject({
        paymentId: "payment_1",
        amountCents: 5000,
      });

      // Same cancellation email to the OWNER — identical args for both actors.
      const emailCalls = mocks.sendBookingCancelledEmail.mock.calls;
      expect(emailCalls).toHaveLength(2);
      expect(emailCalls[0]).toEqual(emailCalls[1]);
      expect(emailCalls[0][0]).toBe("member@example.com");
      expect(emailCalls[0][4]).toBe(5000);

      // Same audit — identical details + settlement metadata + subjectMemberId
      // (the booking owner); ONLY the actor `memberId` differs.
      const auditCalls = mocks.logAudit.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry?.action === "booking.cancel");
      expect(auditCalls).toHaveLength(2);
      const [officerAudit, adminAudit] = auditCalls;
      expect(officerAudit.memberId).toBe("officer-1");
      expect(adminAudit.memberId).toBe("admin-1");
      expect(officerAudit.subjectMemberId).toBe("member_1");
      expect(adminAudit.subjectMemberId).toBe("member_1");
      expect(officerAudit.details).toEqual(adminAudit.details);
      expect(officerAudit.metadata).toEqual(adminAudit.metadata);
    });
  });
});


describe("cancelBooking detaches the held booking-request pointer (issue #1254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    // #1311 (follow-up to #1334): the no-payment claim re-reads the FULL booking
    // row under the advisory lock and sources its downstream reconcile / audit /
    // email / waitlist from THAT read. By default the under-lock re-read returns
    // the same still-held row the outer read saw, so the claim succeeds. The
    // concurrency test overrides the status to model a quote-accept winning the
    // lock race.
    mocks.txBookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "AWAITING_REVIEW",
      finalPriceCents: 1000,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
      payment: null,
    });
    // The no-payment claim now runs inside a $transaction callback (under the
    // advisory lock); the paid branches use the array form. Support both with a
    // full mock tx client so the claim can $executeRaw the lock, re-read, flip
    // status, and detach the held-request pointer inside the transaction.
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            booking: {
              findUnique: mocks.txBookingFindUnique,
              update: mocks.bookingUpdate,
            },
            bookingRequest: {
              updateMany: mocks.bookingRequestUpdateMany,
            },
            payment: {
              update: mocks.paymentUpdate,
            },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
  });

  it("nulls heldBookingId on the owning request when a held AWAITING_REVIEW booking is cancelled", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "AWAITING_REVIEW",
      finalPriceCents: 1000,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
      payment: null,
    });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    // The dangling pointer is detached so a later re-quote creates a fresh hold
    // instead of reusing this now-cancelled row.
    expect(mocks.bookingRequestUpdateMany).toHaveBeenCalledWith({
      where: { heldBookingId: "held-1" },
      data: { heldBookingId: null },
    });
  });

  // #1255 RR-2 (Option A): the admin "Release hold" action passes
  // suppressCustomerNotification so the requester is NOT emailed a cancellation
  // for a hold being administratively released.
  const heldBooking = {
    id: "held-1",
    memberId: "owner-1",
    status: "AWAITING_REVIEW" as const,
    finalPriceCents: 1000,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
    payment: null,
  };

  it("sends the cancellation email for a held booking when notification is NOT suppressed", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "req@example.com",
      "Req",
      heldBooking.checkIn,
      heldBooking.checkOut,
      0,
      "card",
    );
  });

  it("suppresses the cancellation email but still detaches + audits when suppressCustomerNotification is true", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking(
      "held-1",
      "admin-1",
      "ADMIN",
      "127.0.0.1",
      "card",
      { suppressCustomerNotification: true },
    );

    expect(result.status).toBe(200);
    // The customer email is skipped...
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    // ...but the hold is still released: pointer detached and cancellation audited.
    expect(mocks.bookingRequestUpdateMany).toHaveBeenCalledWith({
      where: { heldBookingId: "held-1" },
      data: { heldBookingId: null },
    });
    expect(mocks.logAudit).toHaveBeenCalled();
  });
});

// #1311: the no-payment cancel path must be a status-guarded claim-first under
// the SAME booking advisory lock the quote-accept path takes, so cancelling a
// held AWAITING_REVIEW booking can never clobber a concurrent accept that has
// already converted it to PENDING.
describe("cancelBooking no-payment claim-first (issue #1311)", () => {
  const heldBooking = {
    id: "held-1",
    memberId: "owner-1",
    status: "AWAITING_REVIEW" as const,
    finalPriceCents: 1000,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
    payment: null,
  };

  function lockWasAcquired() {
    return mocks.txExecuteRaw.mock.calls.some((call) =>
      String((call as unknown[])[0]).includes("pg_advisory_xact_lock"),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            booking: {
              findUnique: mocks.txBookingFindUnique,
              update: mocks.bookingUpdate,
            },
            bookingRequest: { updateMany: mocks.bookingRequestUpdateMany },
            payment: { update: mocks.paymentUpdate },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
  });

  it("takes the advisory lock, re-reads status under it, then flips a still-held booking to CANCELLED", async () => {
    // Winner path: both the outer read and the under-lock re-read see
    // AWAITING_REVIEW, so the claim commits. The under-lock read now returns the
    // full row (its data feeds the downstream reconcile/audit/email/waitlist).
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    // The advisory lock is acquired inside the claim tx — this is the only part
    // of the fix a mocked-prisma unit test can pin, and it is what serialises
    // cancel against the quote-accept path (booking-request.ts).
    expect(lockWasAcquired()).toBe(true);
    // The status is re-read under the lock and then flipped exactly once.
    expect(mocks.txBookingFindUnique).toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "held-1" },
      data: {
        status: "CANCELLED",
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistPosition: null,
      },
    });
  });

  it("returns 409 and clobbers NOTHING when a concurrent quote-accept converts the hold under the lock", async () => {
    // Interleave: the cancel's stale outer read still saw AWAITING_REVIEW (so it
    // passed the outer status guard and entered the no-payment branch), but by
    // the time it wins the advisory lock the concurrent quote-accept has already
    // committed AWAITING_REVIEW -> PENDING and released the lock. The under-lock
    // re-read therefore sees PENDING. Absent this re-read the code would have
    // flipped the just-accepted PENDING booking to CANCELLED — the exact clobber
    // #1311 closes.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ status: "PENDING" });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    // The loser gets a real 409, never a false 200.
    expect(result.status).toBe(409);
    // The lock WAS taken and the status WAS re-read under it — proving the guard,
    // not luck, caught the race.
    expect(lockWasAcquired()).toBe(true);
    expect(mocks.txBookingFindUnique).toHaveBeenCalled();
    // NOTHING was clobbered or side-effected: no status flip, no pointer detach,
    // no bed reconcile side effects, no audit, no email, no waitlist re-process.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("returns 409 when another cancel already claimed the booking (re-read sees CANCELLED)", async () => {
    // The other race direction: a concurrent cancel won the lock first and
    // committed CANCELLED. Our re-read under the lock sees CANCELLED (not in the
    // no-payment set), so we abort as a pure no-op rather than double-cancelling.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ status: "CANCELLED" });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(409);
    expect(lockWasAcquired()).toBe(true);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
  });

  // #1311 follow-up to #1334: the winner path must source its downstream
  // reconcile / audit / cancellation email / waitlist re-process from the
  // authoritative UNDER-LOCK read, not the stale pre-lock outer read. Diverge
  // the two reads: the outer read carries stale member + dates, the under-lock
  // read carries the authoritative member + dates (both WAITLIST_OFFERED, so the
  // claim commits and the waitlist branch runs). Every observable downstream
  // consumer must use the under-lock values.
  it("sources the cancellation email, audit, and waitlist from the under-lock fresh row, not the stale outer read", async () => {
    const staleCheckIn = new Date("2026-09-01");
    const staleCheckOut = new Date("2026-09-03");
    const freshCheckIn = new Date("2026-10-05");
    const freshCheckOut = new Date("2026-10-07");

    // Stale pre-lock read: passed the outer status guard, then the row was
    // (hypothetically) re-quoted under a new member/date window before the lock.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "WAITLIST_OFFERED",
      finalPriceCents: 1000,
      checkIn: staleCheckIn,
      checkOut: staleCheckOut,
      member: { id: "owner-1", email: "stale@example.com", firstName: "Stale" },
      payment: null,
    });
    // Authoritative under-lock read: still in the no-payment set (claim wins).
    mocks.txBookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "WAITLIST_OFFERED",
      finalPriceCents: 1000,
      checkIn: freshCheckIn,
      checkOut: freshCheckOut,
      member: { id: "owner-1", email: "fresh@example.com", firstName: "Fresh" },
      payment: null,
    });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(lockWasAcquired()).toBe(true);

    // Email uses the UNDER-LOCK member + dates, never the stale outer read.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "fresh@example.com",
      "Fresh",
      freshCheckIn,
      freshCheckOut,
      0,
      "card",
    );
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalledWith(
      "stale@example.com",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    // Waitlist re-process (WAITLIST_OFFERED) uses the under-lock dates.
    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith({
      checkIn: freshCheckIn,
      checkOut: freshCheckOut,
    });

    // Audit metadata (checkIn/checkOut/statusBefore) is derived from the
    // under-lock row: the ISO dates match the fresh window, not the stale one.
    const auditMetadata = mocks.logAudit.mock.calls[0][0].metadata;
    expect(auditMetadata.checkIn).toBe(freshCheckIn.toISOString());
    expect(auditMetadata.checkOut).toBe(freshCheckOut.toISOString());
    expect(auditMetadata.checkIn).not.toBe(staleCheckIn.toISOString());
  });
});
