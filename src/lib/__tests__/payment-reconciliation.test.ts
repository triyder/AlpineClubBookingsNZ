import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";
import { normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  lodgeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
  planStripeRefundAllocation: (...args: unknown[]) =>
    mocks.planStripeRefundAllocation(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueCapacityClaimFailedRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueCapacityClaimFailedRefundRecovery(...args),
  markCapacityClaimFailedRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markCapacityClaimFailedRefundRecoverySucceeded(...args),
  recordCapacityClaimFailedRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordCapacityClaimFailedRefundRecoveryInlineError(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
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
import logger from "@/lib/logger";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: {
    findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args),
  },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    update: (...args: unknown[]) => mocks.bookingUpdate(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
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
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mocks.bookingFindUnique.mockResolvedValue(makeStaggeredBooking());
    mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
    mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
    // #1765 — default: no prior transaction for the intent (fresh capture).
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
    mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
    mocks.refundPaymentTransactions.mockResolvedValue({ refunds: [] });
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
      plannedAmountCents: 10000,
      totalRefundableCents: 10000,
    });
    mocks.enqueueCapacityClaimFailedRefundRecovery.mockResolvedValue({
      id: "recovery-op-1",
    });
    mocks.markCapacityClaimFailedRefundRecoverySucceeded.mockResolvedValue({
      count: 1,
    });
    mocks.recordCapacityClaimFailedRefundRecoveryInlineError.mockResolvedValue({
      count: 1,
    });
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
    // #1881 — the PAID claim is a status-guarded updateMany, not a bare update.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: { in: expect.arrayContaining([BookingStatus.PAYMENT_PENDING]) },
      },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
      })
    );
  });

  // #1881 — a Stripe capture does both tiers of work (status/money + capacity
  // claim), so it must take BOTH locks, global lock(1) FIRST then the per-lodge
  // capacity lock. Without lock(1) the capture no longer mutually excluded the
  // cancel/hold-release/settlement paths that serialise on lock(1).
  it("takes the global lock(1) before the per-lodge capacity lock (#1881)", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);

    await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_lockorder",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    const rawCalls = mocks.executeRaw.mock.calls.map((call) => {
      const first = call[0] as unknown;
      return Array.isArray(first) ? (first as string[]).join("|") : String(first);
    });
    const globalIdx = rawCalls.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock(1)")
    );
    const lodgeIdx = rawCalls.findIndex((sql) =>
      sql.includes("hashtextextended")
    );
    expect(globalIdx, "global lock(1) present").toBeGreaterThanOrEqual(0);
    expect(lodgeIdx, "per-lodge lock present").toBeGreaterThanOrEqual(0);
    expect(
      globalIdx,
      "global lock(1) acquired before the per-lodge lock"
    ).toBeLessThan(lodgeIdx);
  });

  // #1764 — pay-while-held. An admin capacity hold makes the booking part of
  // the capacity-holding population while still PAYMENT_PENDING; the payment
  // claim must count it exactly ONCE: the settlement capacity re-check
  // excludes the booking's own (held) row, and the PAID flip leaves the hold
  // fields untouched (set-but-inert — the status clause now holds the beds).
  it("settles an admin-held booking counting its capacity exactly once and leaving the hold record inert (#1764)", async () => {
    const heldBooking = {
      ...makeStaggeredBooking(),
      adminCapacityHoldAt: parseDateOnly("2026-04-01"),
      adminCapacityHoldByMemberId: "admin-1",
    };
    mocks.bookingFindUnique.mockResolvedValue(heldBooking);
    // The lodge is otherwise FULL except for the held booking's own beds: if
    // the claim double-counted the held booking (self-occupancy not
    // excluded), this capacity re-check would fail and cancel-refund it.
    mocks.bookingFindMany.mockImplementation(
      async (args: { where?: { id?: { not?: string } } }) => {
        // The occupancy query must exclude the settling booking itself.
        expect(args.where?.id).toEqual({ not: "booking-1" });
        return [
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
        ];
      },
    );

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_held",
      amountCents: 10000,
      paymentMethodId: "pm_held",
    });

    expect(result).toEqual({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    // The PAID flip must not clear (or otherwise write) the hold fields:
    // unhold-after-paid is refused at the API and the record stays inert.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: { in: expect.arrayContaining([BookingStatus.PAYMENT_PENDING]) },
      },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
  });

  // #1641 — the effective-price guard. A card booking with applied credit is
  // captured at finalPrice − applied; the guard must accept that AND the full
  // price (legacy in-flight intents) while still rejecting any other amount.
  describe("#1641 applied-credit effective-price guard", () => {
    const APPLIED = 3000;
    const FINAL = 10000;
    const EFFECTIVE = FINAL - APPLIED; // 7000

    function makeCreditBooking() {
      return {
        id: "booking-1",
        memberId: "member-1",
        status: BookingStatus.PAYMENT_PENDING,
        lodgeId: "lodge-1",
        checkIn: parseDateOnly("2026-05-20"),
        checkOut: parseDateOnly("2026-05-22"),
        finalPriceCents: FINAL,
        guests: [],
        member: { firstName: "Alice", lastName: "Member", email: "alice@example.com" },
      };
    }

    beforeEach(() => {
      mocks.bookingFindUnique.mockResolvedValue(makeCreditBooking());
      mocks.bookingFindMany.mockResolvedValue([]); // no occupancy -> available
      mocks.deriveBookingAppliedCreditCents.mockResolvedValue(APPLIED);
    });

    it("accepts a credit-reduced effective capture and mirrors credit = finalPrice − captured", async () => {
      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: "pi_effective",
        amountCents: EFFECTIVE,
        paymentMethodId: "pm_1",
      });
      expect(result.outcome).toBe("paid");
      // A webhook-first Payment (create branch) carries the split so
      // amountCents + creditAppliedCents = finalPriceCents.
      expect(mocks.paymentUpsert.mock.calls[0][0].create).toMatchObject({
        amountCents: EFFECTIVE,
        creditAppliedCents: APPLIED,
      });
    });

    it("still accepts a legacy full-price capture (mirror credit = 0)", async () => {
      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: "pi_legacy_full",
        amountCents: FINAL,
        paymentMethodId: "pm_1",
      });
      expect(result.outcome).toBe("paid");
      expect(mocks.paymentUpsert.mock.calls[0][0].create).toMatchObject({
        amountCents: FINAL,
        creditAppliedCents: 0,
      });
    });

    it("rejects an amount that is neither full nor effective", async () => {
      await expect(
        markBookingPaymentSucceeded({
          bookingId: "booking-1",
          paymentIntentId: "pi_wrong",
          amountCents: 5000, // neither 10000 nor 7000
          paymentMethodId: "pm_1",
        })
      ).rejects.toThrow("Payment amount does not match booking total");
    });
  });

  it("consumes the POST-lock re-read (not the pre-lock read) for the capacity check (H3)", async () => {
    // Pre-lock read is a lodgeId-only key select; the buggy order consumed its
    // (stale) dates. Give the two reads different dates and prove the capacity
    // occupancy query is scoped by the POST-lock dates.
    mocks.bookingFindUnique
      // pre-lock: the code must use ONLY .lodgeId from this read
      .mockResolvedValueOnce({
        lodgeId: "lodge-1",
        checkIn: parseDateOnly("2026-01-01"),
        checkOut: parseDateOnly("2026-01-03"),
      })
      // post-lock: the full re-read the capacity check/claim consume
      .mockResolvedValueOnce({
        id: "booking-1",
        memberId: "member-1",
        status: BookingStatus.PAYMENT_PENDING,
        lodgeId: "lodge-1",
        checkIn: parseDateOnly("2026-05-20"),
        checkOut: parseDateOnly("2026-05-22"),
        finalPriceCents: 10000,
        guests: [],
        member: { firstName: "Alice", lastName: "Member", email: "alice@example.com" },
      });
    mocks.bookingFindMany.mockResolvedValue([]); // no occupancy -> available

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_h3",
      amountCents: 10000,
      paymentMethodId: null,
    });

    expect(result.outcome).toBe("paid");
    // Pre-lock read selects only the lock key.
    expect(mocks.bookingFindUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "booking-1" },
      select: { lodgeId: true },
    });
    // The capacity occupancy query is bounded by the POST-lock (May) dates, not
    // the January dates that only the pre-lock read carried.
    const occ = mocks.bookingFindMany.mock.calls[0][0];
    expect(occ.where.checkIn.lt).toEqual(
      normalizeDateOnlyForTimeZone(parseDateOnly("2026-05-22"))
    );
    expect(occ.where.checkOut.gt).toEqual(
      normalizeDateOnlyForTimeZone(parseDateOnly("2026-05-20"))
    );
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
    // #1881 — status-guarded updateMany void, not a bare update.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: { in: expect.arrayContaining([BookingStatus.PAYMENT_PENDING]) },
      },
      data: {
        status: BookingStatus.CANCELLED,
        draftExpiresAt: null,
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
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

  // Capacity-race auto-refund durability: when two members race for the last
  // beds and the loser's payment_intent.succeeded lands after the winner
  // claimed capacity, the loser's booking is cancelled inside the claim
  // transaction and auto-refunded inline. That inline Stripe refund is the
  // member's whole charge — a transient failure (Stripe 5xx / network) must
  // leave a durable, cron-replayable recovery operation (the #1349
  // enqueue-then-execute pattern), not just an admin alert email.
  describe("capacity-race auto-refund durable recovery", () => {
    function primeCapacityRaceLoss() {
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
        member: {
          firstName: "Alice",
          lastName: "Member",
          email: "alice@example.com",
        },
      });
      // The winner already committed every bed.
      mocks.bookingFindMany.mockResolvedValue([
        {
          id: "winner-booking",
          status: BookingStatus.PAID,
          checkIn: parseDateOnly("2026-04-10"),
          checkOut: parseDateOnly("2026-04-12"),
          guests: Array.from({ length: LODGE_CAPACITY }, (_, index) => ({
            id: `winner-${index}`,
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-12"),
          })),
        },
      ]);
    }

    it("enqueues a durable refund-recovery op with the claim-frozen plan inside the cancel transaction, so a transient inline refund failure is replayed by the cron instead of stranding the charge", async () => {
      primeCapacityRaceLoss();
      mocks.refundPaymentTransactions.mockRejectedValue(
        new Error("Stripe is unavailable (503)")
      );

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: "pi_race",
        amountCents: 10000,
        paymentMethodId: "pm_123",
      });

      expect(result.outcome).toBe("cancelled_refund_failed");
      expect(result.refundError).toContain("503");

      // The durable debt was persisted with the transaction client (atomic
      // with the CANCELLED flip) BEFORE the Stripe call, carrying the frozen
      // allocation plan and the capacity_claim_failed_<bookingId>_<pi> Stripe
      // key identity via bookingId + paymentIntentId.
      expect(
        mocks.enqueueCapacityClaimFailedRefundRecovery
      ).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueCapacityClaimFailedRefundRecovery).toHaveBeenCalledWith(
        {
          bookingId: "booking-1",
          paymentId: "payment-1",
          paymentIntentId: "pi_race",
          amountCents: 10000,
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 10000 },
          ],
          store: tx,
        }
      );
      // The plan was frozen from the same locked transaction read.
      expect(mocks.planStripeRefundAllocation).toHaveBeenCalledWith({
        paymentId: "payment-1",
        amountCents: 10000,
        store: tx,
      });

      // Failure path: the operation stays PENDING for the cron (never marked
      // succeeded), the inline error is recorded on it for operator
      // visibility, and the existing admin alert still goes out.
      expect(
        mocks.markCapacityClaimFailedRefundRecoverySucceeded
      ).not.toHaveBeenCalled();
      expect(
        mocks.recordCapacityClaimFailedRefundRecoveryInlineError
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-1",
          paymentIntentId: "pi_race",
          message: expect.stringContaining("503"),
        })
      );
      expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalled();
    });

    it("executes the inline refund from the frozen plan under the shared capacity_claim_failed Stripe key prefix and closes the pre-persisted operation on success", async () => {
      primeCapacityRaceLoss();

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: "pi_race",
        amountCents: 10000,
        paymentMethodId: "pm_123",
      });

      expect(result.outcome).toBe("cancelled_refunded");
      // The durable backstop is enqueued unconditionally, before the refund.
      expect(
        mocks.enqueueCapacityClaimFailedRefundRecovery
      ).toHaveBeenCalledTimes(1);
      // The inline refund replays the frozen slices under the same
      // `capacity_claim_failed_<bookingId>_<paymentIntentId>` prefix the cron
      // reconstructs from the persisted operation, with the shared
      // cron-reconstructible metadata shape — so an ambiguous failure
      // (refunded on Stripe, response lost) is replayed, never repeated.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
        paymentId: "payment-1",
        amountCents: 10000,
        reason: "requested_by_customer",
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
        metadata: { bookingId: "booking-1", reason: "capacity_claim_failed" },
        idempotencyKeyPrefix: "capacity_claim_failed_booking-1_pi_race",
      });
      // Happy-path close of the pre-persisted operation.
      expect(
        mocks.markCapacityClaimFailedRefundRecoverySucceeded
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-1",
          paymentIntentId: "pi_race",
        })
      );
      expect(
        mocks.recordCapacityClaimFailedRefundRecoveryInlineError
      ).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });
  });

  // #1771 — a booking deliberately admitted above the ceiling by an admin
  // carries a persisted capacityOverriddenAt marker. The settlement capacity
  // re-check must NOT cancel-and-refund it: it settles to PAID exactly as if it
  // fit, and logs that it skipped the capacity cancel.
  it("settles an over-capacity booking with a persisted capacity override to PAID instead of cancelling (#1771)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: parseDateOnly("2026-04-10"),
      checkOut: parseDateOnly("2026-04-12"),
      finalPriceCents: 10000,
      // Deliberately admitted over the ceiling by an admin (#1668/#1767).
      capacityOverriddenAt: parseDateOnly("2026-04-01"),
      capacityOverriddenByMemberId: "admin-1",
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

    // The lodge is full: without the override this would cancel-and-refund.
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
      paymentIntentId: "pi_override",
      amountCents: 10000,
      paymentMethodId: "pm_123",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: { in: expect.arrayContaining([BookingStatus.PAYMENT_PENDING]) },
      },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    // Never cancelled, never refunded.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
      })
    );
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    // The skip is logged.
    expect(logger.info).toHaveBeenCalledWith(
      { bookingId: "booking-1" },
      expect.stringContaining("persisted capacity override (#1771)")
    );
  });
});
