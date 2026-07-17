import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

// #1992 — the duplicate-capture auto-refund. The residual #1967 split-child
// window lets an in-flight /pay link PaymentIntent (client secret already in
// the member's browser) and the settlement cron's saved-card charge BOTH
// capture. markBookingPaymentSucceeded must:
//   - refund the arriving capture when it is a DIFFERENT intent from the one
//     that settled the already-PAID booking (durable enqueue-then-execute,
//     exactly the duplicate's captured amount, pinned to its own transaction);
//   - keep `already_paid` byte-identical for a SAME-intent replay from every
//     legitimate caller path (webhook redelivery, confirm-payment route,
//     payment-link reconcile, charge-saved-method rerun, cron-confirm-pending
//     rerun, create-payment-intent recovery, confirm-pending-guests retry);
//   - never refund BOTH sides when the two captures' webhooks replay
//     (adjudication marker on the recovery-operation key prefix);
//   - preserve the #1765 refunded-history guard, including the
//     repay-generation case (a fully REFUNDED prior capture is history, not a
//     settlement the repay duplicates).

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  enqueueDuplicateCaptureRefundRecovery: vi.fn(),
  findOtherDuplicateCaptureRefundOperation: vi.fn(),
  markDuplicateCaptureRefundRecoverySucceeded: vi.fn(),
  recordDuplicateCaptureRefundRecoveryInlineError: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
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
  enqueueDuplicateCaptureRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueDuplicateCaptureRefundRecovery(...args),
  findOtherDuplicateCaptureRefundOperation: (...args: unknown[]) =>
    mocks.findOtherDuplicateCaptureRefundOperation(...args),
  markDuplicateCaptureRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markDuplicateCaptureRefundRecoverySucceeded(...args),
  recordDuplicateCaptureRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordDuplicateCaptureRefundRecoveryInlineError(...args),
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

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking,
  buildDuplicateCaptureRefundStripeKeyPrefix,
  bookingModificationRefundReasonForKeyPrefix,
} from "@/lib/payment-recovery-keys";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: {
    findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args),
  },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
  },
  paymentTransaction: {
    findFirst: (...args: unknown[]) => mocks.paymentTransactionFindFirst(...args),
  },
};

type LedgerRow = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
};

function ledgerRow(overrides: Partial<LedgerRow> & { id: string }): LedgerRow {
  return {
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.SUCCEEDED,
    stripePaymentIntentId: null,
    amountCents: 10000,
    refundedAmountCents: 0,
    ...overrides,
  };
}

/**
 * Drive both ledger lookups from one transaction list so the tests exercise
 * the REAL where-clause semantics of the duplicate-capture predicate:
 * `findFirst` honours kind/source/status filters and the arriving-intent
 * exclusion; `findPaymentTransactionByIntentId` resolves by intent id.
 */
function primeLedger(transactions: LedgerRow[]) {
  mocks.paymentTransactionFindFirst.mockImplementation(
    async (args: {
      where: {
        kind: PaymentTransactionKind;
        source: PaymentSource;
        status: { in: PaymentStatus[] };
        stripePaymentIntentId: { not: string };
      };
    }) => {
      const { where } = args;
      return (
        transactions.find(
          (transaction) =>
            transaction.kind === where.kind &&
            transaction.source === where.source &&
            where.status.in.includes(transaction.status) &&
            transaction.stripePaymentIntentId !== null &&
            transaction.stripePaymentIntentId !== where.stripePaymentIntentId.not
        ) ?? null
      );
    }
  );
  mocks.findPaymentTransactionByIntentId.mockImplementation(
    async ({ paymentIntentId }: { paymentIntentId: string }) =>
      transactions.find(
        (transaction) => transaction.stripePaymentIntentId === paymentIntentId
      ) ?? null
  );
}

function makePaidBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PAID,
    lodgeId: "lodge-1",
    checkIn: parseDateOnly("2026-08-10"),
    checkOut: parseDateOnly("2026-08-12"),
    finalPriceCents: 10000,
    parentBookingId: "parent-1",
    guests: [],
    member: {
      firstName: "Alice",
      lastName: "Member",
      email: "alice@example.com",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.bookingFindUnique.mockResolvedValue(makePaidBooking());
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.refundPaymentTransactions.mockResolvedValue({ refunds: [] });
  mocks.enqueueDuplicateCaptureRefundRecovery.mockResolvedValue({
    id: "dup-op-1",
  });
  mocks.findOtherDuplicateCaptureRefundOperation.mockResolvedValue(null);
  mocks.markDuplicateCaptureRefundRecoverySucceeded.mockResolvedValue({
    count: 1,
  });
  mocks.recordDuplicateCaptureRefundRecoveryInlineError.mockResolvedValue({
    count: 1,
  });
});

// The settled auto-charge capture and the arriving in-flight link capture.
const SETTLED_PI = "pi_auto_charge";
const DUPLICATE_PI = "pi_link_intent";

function primeDuplicateCaptureLedger(
  options: { duplicateAmountCents?: number } = {}
) {
  const duplicateAmountCents = options.duplicateAmountCents ?? 10000;
  primeLedger([
    ledgerRow({
      id: "txn-settled",
      stripePaymentIntentId: SETTLED_PI,
      amountCents: 10000,
    }),
    ledgerRow({
      id: "txn-duplicate",
      stripePaymentIntentId: DUPLICATE_PI,
      status: PaymentStatus.PROCESSING,
      amountCents: duplicateAmountCents,
    }),
  ]);
}

describe("#1992 duplicate-capture auto-refund", () => {
  it("refunds a DIFFERENT arriving capture on an already-PAID booking: durable op enqueued inside the transaction, inline refund pinned to the duplicate's own transaction under the shared Stripe key prefix", async () => {
    primeDuplicateCaptureLedger();

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result).toEqual({
      outcome: "duplicate_capture_refunded",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    // The arriving capture is still recorded in the ledger first (real money
    // moved), exactly as before this fix.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.SUCCEEDED,
      })
    );

    // Durable debt enqueued with the transaction client (atomic with the
    // detection, before any Stripe call), pinned to the duplicate transaction.
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      allocationPlan: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      store: tx,
    });

    // Inline refund executes the same frozen slice under the shared
    // duplicate_capture_refund key prefix and cron-reconstructible metadata.
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 10000,
      reason: "requested_by_customer",
      allocation: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      metadata: { bookingId: "booking-1", reason: "duplicate_capture" },
      idempotencyKeyPrefix: `duplicate_capture_refund_booking-1_${DUPLICATE_PI}`,
    });

    // Happy-path close + loud admin alert (money moved automatically).
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
      })
    );
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        paymentIntentId: DUPLICATE_PI,
        errorMessage: expect.stringContaining("automatically refunded"),
      })
    );

    // The booking's status/settlement is untouched: no PAID/CANCELLED claim,
    // no booking event that could later masquerade as a cancellation refund.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("refunds exactly the duplicate's captured amount, not the booking price", async () => {
    // A stale-price duplicate: the link intent was minted at an older 8000
    // total. The refund must hand back the 8000 that was actually captured.
    primeDuplicateCaptureLedger({ duplicateAmountCents: 8000 });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 8000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 8000,
        allocationPlan: [
          { paymentTransactionId: "txn-duplicate", amountCents: 8000 },
        ],
      })
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 8000 })
    );
  });

  it("tolerates an inline refund failure: the pre-persisted operation stays for the recovery cron, the inline error is recorded, admins are alerted", async () => {
    primeDuplicateCaptureLedger();
    mocks.refundPaymentTransactions.mockRejectedValue(
      new Error("Stripe is unavailable (503)")
    );

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refund_failed");
    expect(result.refundError).toContain("503");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
    expect(
      mocks.recordDuplicateCaptureRefundRecoveryInlineError
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        message: expect.stringContaining("503"),
      })
    );
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("recovery cron will retry"),
      })
    );
  });

  it("pins the distinctness predicate's where-clause: captured PRIMARY Stripe transactions with net cash only (SUCCEEDED/PARTIALLY_REFUNDED — never fully REFUNDED), excluding the arriving intent and NULL intent ids", async () => {
    primeDuplicateCaptureLedger();

    await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentId: "payment-1",
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.STRIPE,
          status: {
            in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
          stripePaymentIntentId: { not: DUPLICATE_PI },
          NOT: { stripePaymentIntentId: null },
        },
      })
    );
  });

  it("still refunds the duplicate when the settling capture has since been PARTIALLY refunded (net cash is still held)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 2000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.PROCESSING,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
  });

  describe("SAME-intent replay stays already_paid with NO refund, from every legitimate caller path", () => {
    // Every caller invokes the same choke point with the SETTLED intent id;
    // what varies in production is only who carries it there. Pinning each
    // path by name documents that the duplicate-capture refund can never fire
    // for the normal exactly-once replay outcome of:
    const legitimateReplayPaths = [
      "stripe-webhook payment_intent.succeeded redelivery (stripe-webhook-service)",
      "confirm-payment route racing the webhook (bookings/[id]/confirm-payment)",
      "payment-link reconcile of an existing succeeded intent (createPaymentIntentForPaymentLink)",
      "charge-saved-method rerun replaying the pending_charge_ Stripe idempotency key",
      "cron-confirm-pending rerun replaying the pending_charge_ Stripe idempotency key",
      "create-payment-intent route recovery reconcile of a succeeded intent",
      "admin confirm-pending-guests retry of its recorded charge",
    ];

    it.each(legitimateReplayPaths)("%s", async () => {
      // Ledger holds ONLY the settled capture; the arriving intent IS it.
      primeLedger([
        ledgerRow({
          id: "txn-settled",
          stripePaymentIntentId: SETTLED_PI,
          amountCents: 10000,
        }),
      ]);

      const result = await markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: SETTLED_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result).toEqual({
        outcome: "already_paid",
        bookingId: "booking-1",
        bumpedBookingIds: [],
      });
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });
  });

  it("never refunds BOTH sides: once a duplicate-capture refund is adjudicated against one intent, the OTHER capture's replay stays already_paid", async () => {
    // The duplicate refund of DUPLICATE_PI was already adjudicated (operation
    // row exists). Now the SETTLED intent's webhook redelivers: from the
    // ledger it looks symmetric (a different SUCCEEDED capture exists), so
    // without the adjudication marker this replay would refund the settlement
    // too and leave the booking PAID at zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
      }),
    ]);
    mocks.findOtherDuplicateCaptureRefundOperation.mockResolvedValue({
      id: "dup-op-1",
      idempotencyKey: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
    });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: SETTLED_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.findOtherDuplicateCaptureRefundOperation).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: SETTLED_PI,
      store: tx,
    });
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a redelivery of the duplicate AFTER its refund executed stays already_paid via the #1765 refunded-history guard (no second refund op, no ledger clobber)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    // #1765 — the refunded transaction row is never clobbered back to
    // SUCCEEDED, and no duplicate machinery runs for refund history.
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("repay-generation replay (#1765): the repay capture arriving alongside its fully REFUNDED predecessor is NOT a duplicate", async () => {
    // Paid via pi_old, deliberately refunded, repaid via pi_repay, booking
    // PAID again. A pi_repay webhook redelivery must stay already_paid: the
    // only other capture on the ledger is fully REFUNDED, which the
    // distinctness predicate excludes — auto-refunding the repay would strand
    // the booking PAID with zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-old",
        stripePaymentIntentId: "pi_old",
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
      ledgerRow({
        id: "txn-repay",
        stripePaymentIntentId: "pi_repay",
        amountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_repay",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a normal success on a not-yet-paid booking is untouched by the duplicate machinery", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...makePaidBooking(),
      status: BookingStatus.PENDING,
    });
    primeLedger([]);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_fresh",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a duplicate whose transaction row cannot be resolved falls back to already_paid (no blind refund)", async () => {
    // Other settled capture exists, but the arriving intent has no ledger row
    // to pin the refund slice to — refuse to move money on a guess.
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      })
    );
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });
});

describe("#1992 recovery key builders and replay-metadata mapping", () => {
  it("the operation idempotency key is duplicate_capture_<bookingId>_<intentId> and shares the per-booking adjudication prefix", () => {
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-1", "pi_x")
    ).toBe("duplicate_capture_booking-1_pi_x");
    expect(
      buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
    ).toBe("duplicate_capture_booking-1_");
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        "booking-1",
        "pi_x"
      ).startsWith(
        buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
      )
    ).toBe(true);
  });

  it("the Stripe key prefix maps back to the inline metadata reason, so a cron replay reconstructs a byte-identical refund body", () => {
    const prefix = buildDuplicateCaptureRefundStripeKeyPrefix(
      "booking-1",
      "pi_x"
    );
    expect(prefix).toBe("duplicate_capture_refund_booking-1_pi_x");
    expect(bookingModificationRefundReasonForKeyPrefix(prefix)).toBe(
      "duplicate_capture"
    );
  });
});
