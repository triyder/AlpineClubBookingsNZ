import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentUpsert: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mocks.sendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    update: (...args: unknown[]) => mocks.bookingUpdate(...args),
  },
  payment: {
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
  },
};

function makeStaggeredBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PAYMENT_PENDING,
    checkIn: parseDateOnly("2026-04-10"),
    checkOut: parseDateOnly("2026-04-12"),
    finalPriceCents: 10000,
    guests: [
      {
        id: "guest-1",
        isMember: false,
        stayStart: parseDateOnly("2026-04-10"),
        stayEnd: parseDateOnly("2026-04-11"),
      },
      {
        id: "guest-2",
        isMember: false,
        stayStart: parseDateOnly("2026-04-11"),
        stayEnd: parseDateOnly("2026-04-12"),
      },
    ],
    member: {
      firstName: "Alice",
      lastName: "Member",
      email: "alice@example.com",
    },
  };
}

describe("markBookingPaymentSucceeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) =>
      fn(tx)
    );
    mocks.executeRaw.mockResolvedValue(undefined);
    mocks.bookingFindUnique.mockResolvedValue(makeStaggeredBooking());
    mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
    mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
    mocks.refundPaymentTransactions.mockResolvedValue({});
  });

  it("pays a staggered booking when only one bed is available on each active guest night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "existing-booking",
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_123",
      amountCents: 10000,
      paymentMethodId: "pm_123",
    });

    expect(result).toEqual({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
    });
  });

  // Regression for the R1 overbooking carried into #738: a lodge full of
  // committed (PAID) bookings plus an overlapping PENDING booking (which holds
  // no capacity and so is not in the occupancy query) must not let an
  // all-member booking pay into a non-existent bed by bumping the PENDING hold.
  // It must be cancelled-and-refunded instead.
  it("cancels-and-refunds an all-member booking that does not fit, never bumping a PENDING hold into room", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: parseDateOnly("2026-04-10"),
      checkOut: parseDateOnly("2026-04-12"),
      finalPriceCents: 10000,
      guests: [
        {
          id: "guest-1",
          isMember: true,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        },
      ],
      member: { firstName: "Alice", lastName: "Member", email: "alice@example.com" },
    });

    // The capacity query filters to capacity-holding statuses, so the
    // overlapping PENDING booking is intentionally absent here — only the
    // committed PAID booking that fills the lodge is returned.
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "committed-full",
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: LODGE_CAPACITY }, (_, index) => ({
          id: `committed-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_overbook",
      amountCents: 10000,
      paymentMethodId: "pm_123",
    });

    expect(result.outcome).toBe("cancelled_refunded");
    expect(result.bumpedBookingIds).toEqual([]);
    // The booking is cancelled and the payment refunded — never marked PAID.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: BookingStatus.CANCELLED, draftExpiresAt: null },
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: BookingStatus.PAID }) })
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalled();
    // The capacity_failed system void must restore applied credit at 100% — it
    // calls restoreCreditFromBooking with NO override (exactly 3 args), so the
    // #1164 cancellation tiering never applies to a system void.
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "member-1",
      "booking-1",
      expect.anything()
    );
  });
});
