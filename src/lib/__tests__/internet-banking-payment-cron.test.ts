import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  transaction: vi.fn(),
  txExecuteRaw: vi.fn(),
  txPaymentFindUnique: vi.fn(),
  txPaymentUpdate: vi.fn(),
  txBookingUpdate: vi.fn(),
  createAuditLog: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  revokePaymentLinksForBooking: vi.fn(),
  processWaitlistForDates: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mocks.paymentFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocationsForBooking,
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));

vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinksForBooking,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

import { releaseExpiredInternetBankingHolds } from "@/lib/internet-banking-payment-cron";

const NOW = new Date("2026-07-06T08:00:00Z");

function makeExpiredPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_ib_1",
    bookingId: "booking_ib_1",
    amountCents: 12345,
    status: "PENDING",
    source: "INTERNET_BANKING",
    internetBankingHoldSlots: true,
    internetBankingHoldUntil: new Date("2026-07-05T08:00:00Z"),
    internetBankingHoldReleasedAt: null,
    booking: {
      id: "booking_ib_1",
      memberId: "mem_1",
      status: "CONFIRMED",
      checkIn: new Date("2026-07-20"),
      checkOut: new Date("2026-07-22"),
      member: {
        email: "member@example.com",
        firstName: "Alice",
      },
      guests: [{ id: "guest_1", nights: [] }],
    },
    ...overrides,
  };
}

// #1357 (F17): the invoice-clearing credit note must be enqueued INSIDE the
// release transaction so the outbox row commits atomically with
// internetBankingHoldReleasedAt — a crash after the commit can no longer
// strand the open Xero invoice with no self-heal (re-runs skip released
// holds).
describe("releaseExpiredInternetBankingHolds credit-note durability (#1357)", () => {
  const txRef: { current: unknown } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    txRef.current = null;
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: mocks.txExecuteRaw,
          payment: {
            findUnique: mocks.txPaymentFindUnique,
            update: mocks.txPaymentUpdate,
          },
          booking: {
            update: mocks.txBookingUpdate,
          },
        };
        txRef.current = tx;
        return callback(tx);
      },
    );
    mocks.paymentFindMany.mockResolvedValue([makeExpiredPayment()]);
    mocks.txPaymentFindUnique.mockResolvedValue(makeExpiredPayment());
    mocks.revokePaymentLinksForBooking.mockResolvedValue(undefined);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    // #1547: default = no applied credit on the released booking.
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_note_1",
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(null);
  });

  it("enqueues the invoice-clearing credit note through the release transaction client", async () => {
    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    // The enqueue received the SAME transaction client the release ran in —
    // the outbox row commits atomically with the hold release, not
    // post-commit fire-and-forget.
    expect(txRef.current).not.toBeNull();
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_ib_1",
      12345,
      { store: txRef.current },
    );
    // The Xero-connected kick stays OUTSIDE the transaction (provider calls
    // never run in-tx) and fires because an operation was queued.
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  it("rolls back a failed release and continues with the remaining holds", async () => {
    const poisoned = makeExpiredPayment();
    const healthy = makeExpiredPayment({
      id: "pay_ib_2",
      bookingId: "booking_ib_2",
      booking: {
        ...makeExpiredPayment().booking,
        id: "booking_ib_2",
      },
    });
    mocks.paymentFindMany.mockResolvedValue([poisoned, healthy]);
    mocks.txPaymentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "pay_ib_2" ? healthy : poisoned,
    );
    // The poisoned candidate's enqueue rejects INSIDE its transaction: that
    // release rolls back whole (hold not marked released, so the next run
    // retries it) while the loop continues to the next hold.
    mocks.enqueueXeroRefundCreditNoteOperation
      .mockRejectedValueOnce(new Error("enqueue exploded"))
      .mockResolvedValueOnce({ queueOperationId: "op_refund_note_2" });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.failed).toBe(1);
    expect(result.released).toBe(1);
    expect(result.paymentIds).toEqual(["pay_ib_2"]);
    // Only the healthy candidate's post-commit effects ran.
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue anything for skipped holds", async () => {
    mocks.txPaymentFindUnique.mockResolvedValue(
      makeExpiredPayment({ internetBankingHoldReleasedAt: new Date() }),
    );

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
    // #1547: a skipped hold never touches the credit ledger.
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
  });

  it("restores applied credit inside the release transaction and threads it through the narrative (#1547)", async () => {
    mocks.restoreCreditFromBooking.mockResolvedValue(2000);

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    // Exactly one restore, on the SAME transaction client as the claim, with
    // NO override arg (100% — nothing was captured).
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "mem_1",
      "booking_ib_1",
      txRef.current,
    );
    expect(mocks.restoreCreditFromBooking.mock.calls[0]).toHaveLength(3);
    // The CANCELLED narrative, audit metadata, and email all carry the amount.
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CANCELLED",
        reason: expect.stringContaining(
          "NZ$20.00 of applied account credit was returned.",
        ),
        snapshot: expect.objectContaining({ creditRestoredCents: 2000 }),
      }),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.internet_banking_hold_expired",
        metadata: expect.objectContaining({ creditRestoredCents: 2000 }),
      }),
    );
    const emailCall = mocks.sendBookingCancelledEmail.mock.calls[0];
    expect(emailCall[6]).toBe(2000);
  });

  it("skips the kick when the enqueue deduped to no new operation", async () => {
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    });

    const result = await releaseExpiredInternetBankingHolds(NOW);

    expect(result.released).toBe(1);
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });
});
