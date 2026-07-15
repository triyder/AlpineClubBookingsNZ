/**
 * Split-booking cancellation cascade (issue #738).
 *
 * Cancelling the member (parent) booking also cancels its linked provisional
 * non-member child (PENDING, holds nothing, no payment). Cancelling the child
 * on its own leaves the member booking intact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  prismaTransaction: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  processWaitlistForDates: vi.fn(),
  revokePaymentLinksForBooking: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      findMany: mocks.bookingFindMany,
      update: mocks.bookingUpdate,
    },
    promoRedemption: { findUnique: mocks.promoRedemptionFindUnique },
    promoCode: { update: vi.fn() },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendBookingCancelledEmail: mocks.sendBookingCancelledEmail }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: vi.fn(),
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));
vi.mock("@/lib/waitlist", () => ({ processWaitlistForDates: mocks.processWaitlistForDates }));
vi.mock("@/lib/xero", () => ({ isXeroConnected: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  cancelSetupIntentIfCancellable: vi.fn(),
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
}));
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinksForBooking,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { cancelBooking } from "@/lib/booking-cancel";

describe("cancelBooking split cascade (#738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Callback-form $transaction with a tx that supports the no-payment path.
    mocks.prismaTransaction.mockImplementation(
      async (fnOrActions: unknown) => {
        if (typeof fnOrActions === "function") {
          return (fnOrActions as (tx: unknown) => Promise<unknown>)({
            // #1547: the generic PENDING branch is now a claim-first tx that
            // takes lock(1) and re-reads the booking under it. Wire the under-
            // lock read to the same outer read so the parent's PENDING claim
            // commits; the child sweep still only needs booking.update.
            $executeRaw: vi.fn().mockResolvedValue(undefined),
            booking: {
              findUnique: mocks.bookingFindUnique,
              update: mocks.bookingUpdate,
            },
            payment: { update: vi.fn() },
          });
        }
        return Promise.all(fnOrActions as Array<Promise<unknown>>);
      }
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.revokePaymentLinksForBooking.mockResolvedValue(0);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
  });

  const child = {
    id: "child_1",
    memberId: "member_1",
    parentBookingId: "parent_1",
    status: "PENDING",
    checkIn: new Date("2026-07-10"),
    checkOut: new Date("2026-07-12"),
    member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
  };

  it("cancels the linked provisional child when the member booking is cancelled", async () => {
    // Parent member booking: a simple PENDING member booking (no payment).
    mocks.bookingFindUnique.mockResolvedValue({
      id: "parent_1",
      memberId: "member_1",
      parentBookingId: null,
      status: "PENDING",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    });
    mocks.bookingFindMany.mockResolvedValue([child]);

    const result = await cancelBooking("parent_1", "member_1", "MEMBER", "127.0.0.1");

    expect(result.status).toBe(200);
    // The cascade queried for children of the cancelled parent...
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parentBookingId: "parent_1", status: "PENDING" }),
      })
    );
    // ...and cancelled the child booking.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "child_1" },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
  });

  it("does not cancel a parent when only the non-member child is cancelled", async () => {
    // Cancelling the child directly: it has no children of its own.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "child_1",
      memberId: "member_1",
      parentBookingId: "parent_1",
      status: "PENDING",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: null,
    });
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await cancelBooking("child_1", "member_1", "MEMBER", "127.0.0.1");

    expect(result.status).toBe(200);
    // The cascade looks for children of child_1 (there are none); the parent is
    // never updated.
    expect(mocks.bookingUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "parent_1" } })
    );
  });
});
