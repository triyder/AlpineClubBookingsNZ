import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBookingXeroRepair } from "@/lib/xero-booking-repair";

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking_1",
    memberId: "member_1",
    status: "CONFIRMED",
    checkIn: new Date("2026-06-10T00:00:00Z"),
    checkOut: new Date("2026-06-12T00:00:00Z"),
    totalPriceCents: 10000,
    discountCents: 0,
    finalPriceCents: 10000,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    member: {
      id: "member_1",
      firstName: "Alice",
      lastName: "Tester",
      email: "alice@example.com",
    },
    payment: {
      id: "payment_1",
      amountCents: 10000,
      stripePaymentIntentId: "pi_123",
      stripePaymentMethodId: "pm_123",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      xeroInvoiceNumber: "INV-001",
      status: "SUCCEEDED",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroRefundCreditNoteId: null,
      creditAppliedCents: 0,
      transactions: [],
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    },
    modifications: [],
    creditsFromCancellation: [],
    ...overrides,
  };
}

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation_1",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "BookingModification",
    localId: "mod_1",
    status: "SUCCEEDED",
    idempotencyKey: null,
    correlationKey: null,
    queueType: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectType: "INVOICE",
    xeroObjectId: "inv_1",
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: new Date("2026-05-02T00:00:00Z"),
    completedAt: new Date("2026-05-02T00:00:00Z"),
    createdAt: new Date("2026-05-02T00:00:00Z"),
    updatedAt: new Date("2026-05-02T00:00:00Z"),
    replayable: true,
    ...overrides,
  };
}

function isCapturedTransactionStatus(status: string) {
  return ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(status);
}

function mapAdditionalSummaryStatus(status: string | null | undefined) {
  if (!status) {
    return null;
  }

  if (status === "FAILED") {
    return "FAILED";
  }

  if (isCapturedTransactionStatus(status)) {
    return "SUCCEEDED";
  }

  return "PENDING";
}

function recomputePaymentSummary(payment: any) {
  const transactions = [...(payment.transactions ?? [])].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );

  if (transactions.length === 0) {
    return;
  }

  const capturedAmountCents = transactions.reduce((sum, transaction) => {
    return sum + (isCapturedTransactionStatus(transaction.status) ? transaction.amountCents : 0);
  }, 0);
  const refundedAmountCents = transactions.reduce(
    (sum, transaction) => sum + (transaction.refundedAmountCents ?? 0),
    0
  );
  const latestPrimary = [...transactions]
    .reverse()
    .find((transaction) => transaction.kind === "PRIMARY");
  const latestAdditional = [...transactions]
    .reverse()
    .find((transaction) => transaction.kind === "ADDITIONAL");

  payment.refundedAmountCents = refundedAmountCents;
  payment.amountCents = capturedAmountCents > 0 ? capturedAmountCents : payment.amountCents;

  if (capturedAmountCents > 0) {
    if (refundedAmountCents >= capturedAmountCents) {
      payment.status = "REFUNDED";
    } else if (refundedAmountCents > 0) {
      payment.status = "PARTIALLY_REFUNDED";
    } else {
      payment.status = "SUCCEEDED";
    }
  } else if (latestPrimary) {
    payment.status = latestPrimary.status;
  }

  payment.stripePaymentIntentId = latestPrimary?.stripePaymentIntentId ?? null;
  payment.stripePaymentMethodId =
    latestPrimary?.paymentMethodId ?? payment.stripePaymentMethodId;
  payment.additionalPaymentIntentId = latestAdditional?.stripePaymentIntentId ?? null;
  payment.additionalAmountCents = latestAdditional?.amountCents ?? 0;
  payment.additionalPaymentStatus = mapAdditionalSummaryStatus(
    latestAdditional?.status ?? null
  );
}

function createDependencies(state: {
  bookings: any[];
  links?: any[];
  operations?: any[];
}) {
  const links = state.links ?? [];
  const operations = state.operations ?? [];

  const enqueueXeroSupplementaryInvoiceOperation = vi.fn().mockImplementation(async (params: any) => {
    links.push({
      id: `link_${params.bookingModificationId}`,
      localModel: "BookingModification",
      localId: params.bookingModificationId,
      xeroObjectType: "INVOICE",
      xeroObjectId: `inv_${params.bookingModificationId}`,
      xeroObjectNumber: `INV-${params.bookingModificationId}`,
      xeroObjectUrl: null,
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      queueOperationId: `queue_${params.bookingModificationId}`,
      message: "queued",
    };
  });

  const markPaymentIntentTransactionFailed = vi.fn().mockImplementation(
    async ({ paymentIntentId }: { paymentIntentId: string }) => {
      const booking = state.bookings.find((item) =>
        item.payment?.transactions?.some(
          (transaction: any) =>
            transaction.stripePaymentIntentId === paymentIntentId
        )
      );
      const transaction = booking?.payment?.transactions?.find(
        (item: any) => item.stripePaymentIntentId === paymentIntentId
      );

      if (!transaction || isCapturedTransactionStatus(transaction.status)) {
        return booking?.payment ?? null;
      }

      transaction.status = "FAILED";
      recomputePaymentSummary(booking.payment);
      return booking.payment;
    }
  );

  const refundPaymentTransactions = vi.fn().mockImplementation(
    async ({
      paymentId,
      amountCents,
    }: {
      paymentId: string;
      amountCents: number;
    }) => {
      const booking = state.bookings.find((item) => item.payment?.id === paymentId);
      if (!booking?.payment) {
        throw new Error("Payment not found");
      }

      let remainingAmountCents = amountCents;
      const refunds: Array<{
        paymentIntentId: string;
        refundId: string;
        amountCents: number;
      }> = [];
      const refundableTransactions = [...(booking.payment.transactions ?? [])]
        .filter((transaction: any) => isCapturedTransactionStatus(transaction.status))
        .filter(
          (transaction: any) =>
            transaction.amountCents - transaction.refundedAmountCents > 0
        )
        .sort(
          (left: any, right: any) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime()
        );

      for (const transaction of refundableTransactions) {
        if (remainingAmountCents <= 0) {
          break;
        }

        const refundableAmountCents =
          transaction.amountCents - transaction.refundedAmountCents;
        const refundAmountForTransaction = Math.min(
          remainingAmountCents,
          refundableAmountCents
        );

        transaction.refundedAmountCents += refundAmountForTransaction;
        if (transaction.refundedAmountCents >= transaction.amountCents) {
          transaction.status = "REFUNDED";
        } else if (transaction.refundedAmountCents > 0) {
          transaction.status = "PARTIALLY_REFUNDED";
        }

        refunds.push({
          paymentIntentId: transaction.stripePaymentIntentId,
          refundId: `re_${transaction.stripePaymentIntentId}`,
          amountCents: refundAmountForTransaction,
        });
        remainingAmountCents -= refundAmountForTransaction;
      }

      if (remainingAmountCents > 0) {
        throw new Error("Refund amount exceeds captured Stripe payments");
      }

      recomputePaymentSummary(booking.payment);

      return {
        refunds,
        totalRefundedAmountCents: amountCents,
      };
    }
  );

  return {
    prisma: {
      booking: {
        findMany: vi.fn().mockResolvedValue(state.bookings),
      },
      xeroObjectLink: {
        findMany: vi.fn().mockResolvedValue(links),
      },
      xeroSyncOperation: {
        findMany: vi.fn().mockResolvedValue(operations),
      },
      payment: {
        update: vi.fn().mockImplementation(async ({ where, data }: any) => {
          const booking = state.bookings.find((item) => item.payment?.id === where.id);
          if (booking?.payment) {
            booking.payment = {
              ...booking.payment,
              ...data,
            };
          }
          return booking?.payment ?? null;
        }),
      },
    } as unknown as (typeof import("@/lib/prisma"))["prisma"],
    enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_booking",
      message: "queued",
    }),
    enqueueXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_booking_update",
      message: "queued",
    }),
    enqueueXeroSupplementaryInvoiceOperation,
    enqueueXeroModificationCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_credit_note",
      message: "queued",
    }),
    enqueueXeroAccountCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_account_credit",
      message: "queued",
    }),
    enqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_refund_credit",
      message: "queued",
    }),
    enqueueXeroCreditNoteAllocationOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_allocation",
      message: "queued",
    }),
    enqueueXeroSyncOperationRetry: vi.fn().mockResolvedValue({
      queueOperationId: "queue_retry",
      message: "queued retry",
    }),
    processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }),
    processQueuedXeroOperationRetries: vi.fn().mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }),
    upsertXeroObjectLink: vi.fn().mockImplementation(async (link: any) => {
      links.push({
        id: `upsert_${link.localModel}_${link.localId}_${link.role}`,
        active: true,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        ...link,
      });
      return link;
    }),
    isXeroConnected: vi.fn().mockResolvedValue(false),
    cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(null),
    getPaymentIntent: vi.fn().mockResolvedValue({ status: "canceled" }),
    markPaymentIntentTransactionFailed,
    refundPaymentTransactions,
  };
}

describe("runBookingXeroRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies cancelled unpaid bookings with an open invoice", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        status: "FAILED",
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  it("classifies missing supplementary invoices for positive booking modifications", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_1",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_SUPPLEMENTARY_INVOICE"
    );
  });

  // #1356: a supplementary invoice legitimately parked in WAITING_PAYMENT is
  // not "missing" — re-queueing it would mint a duplicate operation whose
  // default recordPayment books money before any capture exists.
  it("treats a WAITING_PAYMENT supplementary op as blocking, not missing (#1356)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_waiting",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "op_waiting",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "BookingModification",
          localId: "mod_waiting",
          status: "WAITING_PAYMENT",
          xeroObjectType: null,
          xeroObjectId: null,
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "BLOCKED_BY_XERO_OPERATION"
    );
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_SUPPLEMENTARY_INVOICE"
    );
  });

  // #1356 (F16): the repair pass verifies supplementary invoices against the
  // modification NET, so the invoice it queues must carry the signed price
  // reduction — a clamped component would immediately fail its own
  // amount-evidence check.
  it("queues mixed-sign supplementary invoices with the signed price reduction (#1356)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_mixed",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    const queueAction = bookingReport.actions.find(
      (action) => action.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(queueAction?.payload).toMatchObject({
      bookingModificationId: "mod_mixed",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });
  });

  it("flags supplementary invoice amount evidence mismatches for manual review", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_amount_invoice",
          bookingId: "booking_1",
          modificationType: "GUEST_ADD",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_supplementary_amount",
          localModel: "BookingModification",
          localId: "mod_amount_invoice",
          xeroObjectType: "INVOICE",
          xeroObjectId: "inv_mod_amount",
          xeroObjectNumber: "INV-AMOUNT",
          xeroObjectUrl: null,
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
          metadata: { amountCents: 2500 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const amountFinding = report.passes[0].bookings[0].findings.find(
      (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
    );
    expect(amountFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: {
        modificationId: "mod_amount_invoice",
        expectedAmountCents: 3000,
        xeroObjectId: "inv_mod_amount",
      },
    });
    expect(amountFinding?.actions[0]?.type).toBe("MARK_MANUAL_REVIEW");
  });

  it("classifies stale primary invoice details after a zero-net date change", async () => {
    const booking = makeBooking({
      checkIn: new Date("2026-05-30T00:00:00Z"),
      checkOut: new Date("2026-05-31T00:00:00Z"),
      modifications: [
        {
          id: "mod_date_1",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          previousData: {
            checkIn: "2026-05-29",
            checkOut: "2026-05-30",
          },
          newData: {
            checkIn: "2026-05-30",
            checkOut: "2026-05-31",
          },
          priceDiffCents: 0,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "STALE_PRIMARY_INVOICE_DETAILS"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_PRIMARY_INVOICE_UPDATE"
    );
  });

  // #1427: with a CAPTURED payment and no stored evidence, the settlement a
  // missing credit note should carry may have been policy-limited below
  // abs(net) — auto-queueing abs(net) would over-credit Xero income by the
  // policy-retained share, so a human sizes it.
  it("routes a missing modification credit note to manual review when the payment captured money and no stored evidence exists (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_2",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "MARK_MANUAL_REVIEW"
    );
  });

  // #1427: no captured payment means no cancellation-policy tier can have
  // applied — the full delta is the correct bookkeeping correction (#1015),
  // and it stays auto-applyable.
  it("queues a missing modification credit note at abs(net) when the payment never captured money", async () => {
    const booking = makeBooking({
      payment: {
        ...makeBooking().payment,
        status: "PENDING",
      },
      modifications: [
        {
          id: "mod_2",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        bookingModificationId: "mod_2",
        refundAmountCents: 3000,
      },
    });
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: { refundAmountSource: "net-amount" },
    });
  });

  // #1427 failure scenario 1: the lost note was enqueued at the
  // policy-limited settlement (5000 of a 10000 reduction). The requeue must
  // replay the STORED amount — abs(net) would over-credit Xero by the
  // policy-retained half and mint a different amount-embedding correlation
  // key (duplicate-note risk if the original attempt reached Xero).
  it("sizes a missing modification credit note from the stored operation payload, not abs(net) (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_stored",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_cancelled_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_stored",
          // CANCELLED: not blocking, not resolvable as an existing note —
          // but its enqueue-time payload still records the settlement.
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_stored",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        bookingModificationId: "mod_stored",
        refundAmountCents: 5000,
      },
    });
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: {
        refundAmountCents: 5000,
        refundAmountSource: "operation-request",
      },
    });
  });

  // #1427: an ACCOUNT-credit-note op shares entityType/operationType with
  // the invoice-applied note op on the same modification — its amount must
  // never size the invoice-applied note. With no usable evidence and a
  // captured payment, the safe route is manual review.
  it("ignores account-credit-note operation payloads when sizing the invoice-applied note (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_account_credit",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_account_credit",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_account_credit",
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_account_credit",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
  });

  // #1427: executors overwrite requestPayload at dispatch — the executed
  // account-credit op's payload becomes a bare document with NO queueType.
  // The immutable queueType COLUMN must still keep it out of the
  // invoice-applied note's resolution and evidence.
  it("discriminates an EXECUTED account-credit note by its queueType column despite the overwritten payload (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_exec_account",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_exec_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_exec_account",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_account",
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          // The executor replaced the enqueue payload with the raw Xero
          // document — no queueType, no refundAmountCents.
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 20.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.actions.filter(
        (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
      )
    ).toEqual([]);
    // The executed account note IS the settlement — no missing-note nag.
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // #1427: the executed invoice-applied note's overwritten payload keeps
  // refundAmountCents — the column-vetted loose read must still recover it.
  it("recovers the settlement from an EXECUTED invoice-applied note's overwritten payload (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_exec_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_exec_note",
          localModel: "BookingModification",
          localId: "mod_exec_note",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_note",
          xeroObjectNumber: "CN-EXEC",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_exec_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_exec_note",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_note",
          queueType: "MODIFICATION_CREDIT_NOTE",
          // Executor-overwritten shape: document + invoiceId +
          // refundAmountCents, queueType key gone.
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
            invoiceId: "inv_primary",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_exec_note"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_exec_note", amountCents: 5000 },
    });
  });

  // #1427 (the #1356 third-arm rule): a pending/running credit-note
  // operation must surface as blocked instead of silence.
  it("surfaces a pending modification credit-note operation as blocked instead of staying silent (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_pending",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_pending_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pending",
          status: "PENDING",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_pending",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const blocked = bookingReport.findings.find(
      (candidate) => candidate.code === "BLOCKED_BY_XERO_OPERATION"
    );
    expect(blocked).toMatchObject({
      severity: "warning",
      safeToAutoApply: false,
      details: { operationId: "operation_pending_note" },
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  // #1427: the expected amount is now the STORED settlement (op request
  // 3000), so the policy-limited note itself is clean — but the allocation
  // evidence (4000) exceeds the note's settlement and must surface.
  it("flags allocation evidence that disagrees with the stored note settlement (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_amount_credit",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_amount",
          localModel: "BookingModification",
          localId: "mod_amount_credit",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_amount",
          xeroObjectNumber: "CN-AMOUNT",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_allocation_amount",
          localModel: "BookingModification",
          localId: "mod_amount_credit",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_amount",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_amount",
            invoiceId: "inv_primary",
            amountCents: 4000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_credit_amount",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_amount_credit",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_amount",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_amount_credit",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const amountFindings = bookingReport.findings.filter(
      (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
    );
    // The note itself matches its stored settlement — no note mismatch.
    expect(
      amountFindings.find(
        (finding) => finding.details.xeroObjectId === "cn_amount"
      )
    ).toBeUndefined();
    const allocationFinding = amountFindings.find(
      (finding) => finding.details.xeroObjectId === "alloc_amount"
    );
    expect(allocationFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: {
        modificationId: "mod_amount_credit",
        expectedAmountCents: 3000,
        xeroObjectId: "alloc_amount",
      },
    });
    expect(allocationFinding?.details.mismatches).toEqual([
      {
        source: "link",
        amountCents: 4000,
        linkId: "link_allocation_amount",
      },
    ]);
  });

  // #1427 failure scenario 2 regression: a correct policy-limited note
  // (5000 of a 10000 reduction) with consistent stored evidence must NOT be
  // flagged against abs(net).
  it("does not flag a policy-limited credit note whose stored evidence agrees (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_policy",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_policy_note",
          localModel: "BookingModification",
          localId: "mod_policy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_policy",
          xeroObjectNumber: "CN-POLICY",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_policy_allocation",
          localModel: "BookingModification",
          localId: "mod_policy",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_policy",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_policy",
            invoiceId: "inv_primary",
            amountCents: 5000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_policy_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_policy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_policy",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_policy",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
      )
    ).toEqual([]);
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "MARK_MANUAL_REVIEW"
    );
  });

  // Genuine drift still surfaces: the note Xero actually holds disagrees
  // with the settlement it was enqueued with.
  it("still flags a note whose executed total drifted from its stored settlement (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_drift",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_drift_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_drift",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_drift",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_drift",
            refundAmountCents: 5000,
          },
          responsePayload: {
            creditNotes: [{ creditNoteID: "cn_drift", total: 65.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const amountFinding = report.passes[0].bookings[0].findings.find(
      (finding) =>
        finding.code === "XERO_AMOUNT_MISMATCH" &&
        finding.details.xeroObjectId === "cn_drift"
    );
    expect(amountFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: { expectedAmountCents: 5000 },
    });
    expect(amountFinding?.details.mismatches).toEqual([
      {
        source: "operation-response",
        amountCents: 6500,
        operationId: "operation_drift_note",
      },
    ]);
  });

  // #1427: the note exists but nothing records its settlement and the
  // payment captured money — allocating abs(net) against a possibly
  // policy-limited note over-repairs the books, so a human confirms first.
  it("routes a missing allocation to manual review when the note's settlement is unknown and money was captured (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_3",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_note",
          localModel: "BookingModification",
          localId: "mod_3",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_mod_3",
          xeroObjectNumber: "CN-003",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_CREDIT_NOTE_ALLOCATION"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
  });

  it("queues a missing allocation at abs(net) when the payment never captured money", async () => {
    const booking = makeBooking({
      payment: {
        ...makeBooking().payment,
        status: "PENDING",
      },
      modifications: [
        {
          id: "mod_3",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_note",
          localModel: "BookingModification",
          localId: "mod_3",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_mod_3",
          xeroObjectNumber: "CN-003",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        creditNoteId: "cn_mod_3",
        amountCents: 4000,
      },
    });
  });

  // #1427 (B1): the resolved note's own enqueue payload outranks a later
  // CANCELLED null-id attempt at a different amount — a retired mis-sized
  // re-queue must neither flag the healthy note nor size its allocation.
  it("prefers the resolved note's own payload over a newer cancelled attempt (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_order",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_order_note",
          localModel: "BookingModification",
          localId: "mod_order",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_order",
          xeroObjectNumber: "CN-ORDER",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_order_original",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_order",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_order",
          createdAt: new Date("2026-05-02T10:00:00Z"),
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_order",
            refundAmountCents: 5000,
          },
        }),
        makeOperation({
          id: "operation_order_cancelled",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_order",
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          createdAt: new Date("2026-05-02T10:05:00Z"),
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_order",
            refundAmountCents: 8000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    // The 5000 note reads clean against its own payload.
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_order"
      )
    ).toEqual([]);
    // And the missing allocation is sized from the note's payload, not the
    // cancelled attempt and not abs(net).
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_order", amountCents: 5000 },
    });
  });

  // #1427: a bare legacy payload (no queueType) still sizes the expectation
  // as a last resort — it must not fall back to abs(net) and flag the note
  // it itself describes.
  it("sizes from a bare legacy payload instead of flagging the note against abs(net) (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_legacy",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_legacy_note",
          localModel: "BookingModification",
          localId: "mod_legacy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_legacy",
          xeroObjectNumber: "CN-LEGACY",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_legacy_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_legacy",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_legacy",
          requestPayload: { refundAmountCents: 3000 },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_legacy"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_legacy", amountCents: 3000 },
    });
  });

  // #1427: a PARTIAL account-credit-note op with no object id must not
  // pollute the invoice-applied note's mismatch evidence.
  it("keeps account-credit operation payloads out of the note's mismatch evidence (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_pollute",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_pollute_note",
          localModel: "BookingModification",
          localId: "mod_pollute",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_pollute",
          xeroObjectNumber: "CN-POLLUTE",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_pollute_allocation",
          localModel: "BookingModification",
          localId: "mod_pollute",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_pollute",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_pollute",
            invoiceId: "inv_primary",
            amountCents: 5000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_pollute_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pollute",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_pollute",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_pollute",
            refundAmountCents: 5000,
          },
        }),
        makeOperation({
          id: "operation_pollute_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pollute",
          status: "PARTIAL",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            paymentId: "payment_1",
            bookingModificationId: "mod_pollute",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    expect(
      report.passes[0].bookings[0].findings.filter(
        (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
      )
    ).toEqual([]);
  });

  // #1427 (C4): a SUCCEEDED account-credit-note op must not resolve as the
  // invoice-applied note (its allocation against the primary invoice would
  // double-count the credit) nor block the missing-note classification.
  it("does not resolve or block on an account-credit note when the invoice-applied note is missing (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_misresolve",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_account_success",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_misresolve",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_account_note",
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            paymentId: "payment_1",
            bookingModificationId: "mod_misresolve",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    // No allocation of the account note against the primary invoice, no
    // wrong link, no blocked finding — and no "missing note" nag either:
    // the account credit IS this modification's legitimate settlement.
    const allocationActions = bookingReport.actions.filter(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(allocationActions).toEqual([]);
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "MISSING_CREDIT_NOTE_ALLOCATION",
          "BLOCKED_BY_XERO_OPERATION",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // #1427 BLOCKER regression (review, empirically reproduced): the
  // pre-column executed ledger has queueType NULL in BOTH the column (the
  // #1347 backfill copied from already-overwritten payloads) and the
  // payload (the account-credit executor leaves a bare document). The
  // correlation-key segment is the only surviving discriminator — without
  // it, the member's unapplied account-credit note resolves as the
  // invoice-applied note and gets allocated against the PAID primary
  // invoice, sized to its own total so Xero silently accepts.
  it("discriminates a PRE-COLUMN executed account-credit note by its correlation key (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_precol_account",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_precol_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_precol_account",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_account",
          queueType: null,
          correlationKey:
            "booking-mod:mod_precol_account:mod-unapplied-credit-note:5000:v1",
          idempotencyKey:
            "booking-mod:mod_precol_account:mod-unapplied-credit-note:5000:v1",
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.actions.filter(
        (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
      )
    ).toEqual([]);
    // Settled by account credit: nothing to repair, nothing to nag.
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "MISSING_CREDIT_NOTE_ALLOCATION",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // The pre-column executed INVOICE-APPLIED note keeps working through the
  // same correlation-key hint: overwritten payload, null column.
  it("recovers a PRE-COLUMN executed invoice-applied note via its correlation key (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_precol_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_precol_note",
          localModel: "BookingModification",
          localId: "mod_precol_note",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_note",
          xeroObjectNumber: "CN-PRECOL",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_precol_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_precol_note",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_note",
          queueType: null,
          correlationKey:
            "booking-mod:mod_precol_note:mod-credit-note:5000:v1",
          idempotencyKey:
            "booking-mod:mod_precol_note:mod-credit-note:5000:v1",
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
            invoiceId: "inv_primary",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_precol_note"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_precol_note", amountCents: 5000 },
    });
  });

  // #1427 third arm for allocations: a live-but-not-retryable allocation op
  // blocks instead of minting a differently-sized sibling.
  it("surfaces a pending allocation operation as blocked instead of re-queueing beside it (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_alloc_pending",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_alloc_pending_note",
          localModel: "BookingModification",
          localId: "mod_alloc_pending",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_alloc_pending",
          xeroObjectNumber: "CN-AP",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_alloc_pending",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
          localId: "mod_alloc_pending",
          status: "PENDING",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: null,
          requestPayload: {
            queueType: "CREDIT_NOTE_ALLOCATION",
            creditNoteId: "cn_alloc_pending",
            invoiceId: "inv_primary",
            amountCents: 4000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    const blocked = bookingReport.findings.find(
      (candidate) =>
        candidate.code === "BLOCKED_BY_XERO_OPERATION" &&
        candidate.details.operationId === "operation_alloc_pending"
    );
    expect(blocked).toMatchObject({
      severity: "warning",
      safeToAutoApply: false,
    });
  });

  // #1427: a FAILED-unretryable blocking op must say so — not claim to be
  // "pending or running".
  it("labels a failed unretryable credit-note operation accurately in the blocked finding (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_failed_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_failed_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_failed_note",
          status: "FAILED",
          replayable: false,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_failed_note",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const blocked = report.passes[0].bookings[0].findings.find(
      (candidate) =>
        candidate.code === "BLOCKED_BY_XERO_OPERATION" &&
        candidate.details.operationId === "operation_failed_note"
    );
    expect(blocked).toMatchObject({ safeToAutoApply: false });
    expect(blocked?.summary).toContain("cannot be auto-retried");
  });

  it("is idempotent on reruns once a missing supplementary invoice has been repaired", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_4",
          bookingId: "booking_1",
          modificationType: "GUEST_ADD",
          priceDiffCents: 1500,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const state = {
      bookings: [booking],
      links: [] as any[],
      operations: [] as any[],
    };
    const deps = createDependencies(state);

    const firstRun = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(firstRun.passes.length).toBeGreaterThan(1);
    expect(firstRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);

    const secondRun = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(secondRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);
  });

  it("classifies cancelled bookings using per-intent transaction state instead of aggregate payment status", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        additionalPaymentIntentId: "pi_additional_pending",
        additionalAmountCents: 3000,
        additionalPaymentStatus: "PENDING",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_additional",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_additional_pending",
            amountCents: 3000,
            refundedAmountCents: 0,
            status: "PENDING",
            paymentMethodId: null,
            reason: "date_change",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "CANCELLED_IN_FLIGHT_PAYMENT"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );

    const inFlightAction = bookingReport.actions.find(
      (action) => action.type === "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT"
    );
    expect(inFlightAction?.payload).toMatchObject({
      paymentIntentIds: ["pi_additional_pending"],
    });

    const lateCaptureAction = bookingReport.actions.find(
      (action) => action.type === "AUTO_REFUND_LATE_CAPTURED_PAYMENT"
    );
    expect(lateCaptureAction?.payload).toMatchObject({
      paymentId: "payment_1",
      refundAmountCents: 10000,
    });
  });

  it("marks only the outstanding cancelled transaction failed during apply mode", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 10000,
        status: "REFUNDED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        additionalPaymentIntentId: "pi_additional_pending",
        additionalAmountCents: 3000,
        additionalPaymentStatus: "PENDING",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_refunded",
            amountCents: 10000,
            refundedAmountCents: 10000,
            status: "REFUNDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_additional",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_additional_pending",
            amountCents: 3000,
            refundedAmountCents: 0,
            status: "PENDING",
            paymentMethodId: null,
            reason: "guest_add",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_additional_pending",
    });
    expect(booking.payment.status).toBe("REFUNDED");
    expect(booking.payment.additionalPaymentStatus).toBe("FAILED");
    expect(report.summary.bookingsWithFindings).toBe(0);
  });

  it("refunds cancelled late captures through the shared multi-intent refund helper", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 13000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        additionalPaymentIntentId: "pi_additional_captured",
        additionalAmountCents: 3000,
        additionalPaymentStatus: "SUCCEEDED",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_additional",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_additional_captured",
            amountCents: 3000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: null,
            reason: "date_change",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 13000,
      reason: "requested_by_customer",
      metadata: {
        bookingId: "booking_1",
        reason: "cancelled_booking_late_capture_repair",
      },
      idempotencyKeyPrefix: "late_cancel_refund_repair_booking_1",
    });
    expect(booking.payment.status).toBe("REFUNDED");
    expect(report.summary.bookingsWithFindings).toBe(0);
  });
});
