import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

const mocks = vi.hoisted(() => ({
  groupBookingFindUnique: vi.fn(),
  groupBookingUpdate: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentUpdate: vi.fn(),
  settlementUpdate: vi.fn(),
  transaction: vi.fn(),
  processRefund: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  revokePaymentLinks: vi.fn(),
  recordBookingEvent: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  processWaitlistForDates: vi.fn(),
  enqueueXeroRefund: vi.fn(),
  kickXero: vi.fn(),
  isXeroConnected: vi.fn(),
  logAudit: vi.fn(),
}));

const txClient = {
  booking: { update: mocks.bookingUpdate },
  payment: { update: mocks.paymentUpdate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: {
      findUnique: mocks.groupBookingFindUnique,
      update: mocks.groupBookingUpdate,
    },
    booking: { findMany: mocks.bookingFindMany },
    groupBookingSettlement: { update: mocks.settlementUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));
vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: mocks.calculateRefundAmount,
  daysUntilDate: mocks.daysUntilDate,
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinks,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefund,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { settleGroupBookingOnOrganiserCancel } from "@/lib/group-cancel";

const ORG_BOOKING = "org-booking-1";
const GROUP_ID = "group-1";
const ORGANISER = "organiser-1";
const CHECK_IN = new Date("2026-07-01");
const CHECK_OUT = new Date("2026-07-03");

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    memberId: "joiner-member-1",
    parentBookingId: ORG_BOOKING,
    status: BookingStatus.PAYMENT_PENDING,
    finalPriceCents: 4500,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    organiserSettled: true,
    member: { email: "joiner@example.com", firstName: "Jo" },
    payment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (cb: (tx: typeof txClient) => unknown) =>
    cb(txClient)
  );
  mocks.bookingUpdate.mockResolvedValue(undefined);
  mocks.paymentUpdate.mockResolvedValue(undefined);
  mocks.groupBookingUpdate.mockResolvedValue(undefined);
  mocks.settlementUpdate.mockResolvedValue(undefined);
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.revokePaymentLinks.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
  mocks.processWaitlistForDates.mockResolvedValue(undefined);
  mocks.enqueueXeroRefund.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue(undefined);
  mocks.isXeroConnected.mockResolvedValue(false);
  mocks.processRefund.mockResolvedValue({ id: "re_1", amount: 9000 });
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(undefined);
  mocks.daysUntilDate.mockReturnValue(30);
  mocks.loadCancellationPolicy.mockResolvedValue([]);
  // Default: full policy refund (refund == amount paid).
  mocks.calculateRefundAmount.mockImplementation((amountCents: number) => ({
    refundAmountCents: amountCents,
    refundPercentage: 100,
  }));
});

describe("settleGroupBookingOnOrganiserCancel", () => {
  it("is a no-op when the cancelled booking does not host a group", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(null);
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    expect(mocks.groupBookingUpdate).not.toHaveBeenCalled();
    expect(mocks.processRefund).not.toHaveBeenCalled();
  });

  it("EACH_PAYS_OWN: closes the group and leaves joiner bookings intact", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      settlement: null,
    });
    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("ORGANISER_PAYS unpaid: cancels children, releases beds, no refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: null,
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.PAYMENT_PENDING }),
      child({ id: "child-2", status: BookingStatus.PAYMENT_PENDING }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(2);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card"
    );
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("ORGANISER_PAYS settled: one refund, per-child Xero credit notes, children cancelled", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
      child({
        id: "child-2",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-2", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // Exactly one Stripe refund for the combined total.
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_settle_1",
        amountCents: 9000,
      })
    );
    // Settlement marked fully refunded.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // Per-child Xero refund credit notes.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
    });
    // Each child's payment marked refunded and booking cancelled.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    // Joiners emailed with their refund amount.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      4500,
      "card"
    );
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("Fix #3: keys the refund by the stable settlement id, not the tier-dependent amount", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "child-1",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "group_cancel_refund_settle-1",
      })
    );
  });

  it("ORGANISER_PAYS mid-settlement: voids the open intent, fails the settlement, no refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({ id: "child-1", status: BookingStatus.CONFIRMED }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_settle_1");
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.FAILED },
    });
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card"
    );
  });

  it("ORGANISER_PAYS settled with a late unpaid joiner: refunds only the paid child", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      child({
        id: "paid-child",
        status: BookingStatus.PAID,
        finalPriceCents: 4500,
        payment: { id: "pay-1", amountCents: 4500, refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
      }),
      // Joined after settlement; never charged.
      child({ id: "late-child", status: BookingStatus.PAYMENT_PENDING, finalPriceCents: 4500, payment: null }),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4500 })
    );
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // Only the paid child generated a Xero credit note.
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
    });
    // Both children cancelled and beds released.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("settleGroupBookingOnOrganiserCancel re-drivability (#1236)", () => {
  function paidChild(id: string, paymentId: string) {
    return child({
      id,
      status: BookingStatus.PAID,
      finalPriceCents: 4500,
      payment: {
        id: paymentId,
        amountCents: 4500,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
    });
  }

  it("first run persists the refund plan before issuing the Stripe refund", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: null,
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // The plan (record of record) is persisted before any money moves.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { refundPlan: { "child-1": 4500 } },
    });
    const persistCallIdx = mocks.settlementUpdate.mock.calls.findIndex(
      ([arg]) => arg?.data?.refundPlan !== undefined
    );
    const persistOrder =
      mocks.settlementUpdate.mock.invocationCallOrder[persistCallIdx];
    const refundOrder = mocks.processRefund.mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(refundOrder);
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
  });

  it("re-drive after the flip applies the plan mirror without a new refund", async () => {
    // Crash-after-flip: settlement already REFUNDED, plan persisted, the paid
    // child is still active (the child-loop had not reached it). This is the
    // core fix — the mirror must be reconstructed from the plan, not skipped.
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // No new money move — the refund already ran on the interrupted first run.
    expect(mocks.processRefund).not.toHaveBeenCalled();
    // The plan is reused verbatim, never recomputed (policy never consulted).
    expect(mocks.calculateRefundAmount).not.toHaveBeenCalled();
    // The per-child mirror is still applied from the plan.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.enqueueXeroRefund).toHaveBeenCalledWith("pay-1", 4500, {
      createdByMemberId: ORGANISER,
    });
    expect(mocks.groupBookingUpdate).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { status: GroupBookingStatus.CANCELLED },
    });
  });

  it("re-drive before the refund issues the refund once, then applies the plan", async () => {
    // Crash-after-persist-before-refund: plan set but settlement still SUCCEEDED.
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // Reused, not recomputed.
    expect(mocks.calculateRefundAmount).not.toHaveBeenCalled();
    // The refund runs exactly once (Stripe dedups the retried key upstream).
    expect(mocks.processRefund).toHaveBeenCalledTimes(1);
    expect(mocks.processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        idempotencyKey: "group_cancel_refund_settle-1",
      })
    );
    // Settlement flips, mirror applied.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
  });

  it("nulls the persisted plan and cancels children unrefunded when the refund fails", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.SUCCEEDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: { "child-1": 4500 },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);
    mocks.processRefund.mockRejectedValueOnce(new Error("stripe down"));

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    // The persisted plan is cleared (DbNull) so a later re-drive cannot re-apply
    // a mirror — or re-attempt a refund — for money that never moved.
    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { refundPlan: Prisma.DbNull },
    });
    // The settlement is left SUCCEEDED for an operator (never flipped).
    expect(mocks.settlementUpdate).not.toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    // The child is still cancelled and its bed released, but with no refund.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroRefund).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      "joiner@example.com",
      "Jo",
      CHECK_IN,
      CHECK_OUT,
      0,
      "card"
    );
  });

  it("skips malformed persisted refund-plan entries without throwing", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        // Only the valid integer entry survives; negative, non-integer and
        // non-numeric values are skipped.
        refundPlan: {
          "child-1": 4500,
          "child-neg": -1,
          "child-float": 1.5,
          "child-str": "9000",
        },
      },
    });
    mocks.bookingFindMany.mockResolvedValue([
      paidChild("child-1", "pay-1"),
      paidChild("child-neg", "pay-neg"),
    ]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    // Only the valid entry applies a mirror.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 4500, status: PaymentStatus.REFUNDED },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledTimes(1);
    // Both children are still cancelled.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
  });

  it("treats an empty persisted refund plan as no refunds", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue({
      id: GROUP_ID,
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      settlement: {
        id: "settle-1",
        status: PaymentStatus.REFUNDED,
        amountCents: 4500,
        stripePaymentIntentId: "pi_settle_1",
        refundPlan: {},
      },
    });
    mocks.bookingFindMany.mockResolvedValue([paidChild("child-1", "pay-1")]);

    await settleGroupBookingOnOrganiserCancel(ORG_BOOKING, ORGANISER, "1.2.3.4");

    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child-1" },
      data: { status: BookingStatus.CANCELLED },
    });
  });
});
