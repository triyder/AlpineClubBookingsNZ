import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  memberCreditGroupBy: vi.fn(),
  memberCreditCount: vi.fn(),
  isXeroConnected: vi.fn(),
  getRefundsMissingXeroCreditNotes: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberCredit: {
      groupBy: mocks.memberCreditGroupBy,
      count: mocks.memberCreditCount,
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation:
    mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/xero-admin-health", () => ({
  REFUND_CREDIT_NOTE_GRACE_HOURS: 24,
  getRefundsMissingXeroCreditNotes: mocks.getRefundsMissingXeroCreditNotes,
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { reconcileCreditBalances } from "@/lib/cron-credit-reconciliation";
import { resetObservabilityBridgeForTests } from "@/lib/observability-bridge";

beforeEach(() => {
  vi.clearAllMocks();
  resetObservabilityBridgeForTests();
  mocks.memberCreditGroupBy.mockResolvedValue([]);
  mocks.memberCreditCount.mockResolvedValue(0);
  mocks.isXeroConnected.mockResolvedValue(false);
  mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
    count: 0,
    payments: [],
  });
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
    queueOperationId: "op_heal_1",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  });
});

describe("reconcileCreditBalances", () => {
  it("includes refunds missing Xero credit notes in the daily cron result", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "book_1",
          memberName: "Jane Doe",
          memberEmail: "jane@example.com",
          refundedAmountCents: 4200,
          refundedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });

    const result = await reconcileCreditBalances();

    expect(result).toEqual({
      membersWithCredit: 0,
      totalCreditCents: 0,
      discrepancies: 0,
      refundsMissingXeroCreditNotes: 2,
    });
    expect(mocks.getRefundsMissingXeroCreditNotes).toHaveBeenCalledWith({
      // #1354: raised so the self-heal pass re-enqueues a fuller set per tick.
      limit: 50,
    });
  });

  it("emits a structured daily alert without member PII when refunded Stripe payments are missing Xero credit notes", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 1,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "book_1",
          memberName: "Jane Doe",
          memberEmail: "jane@example.com",
          refundedAmountCents: 4200,
          refundedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });

    await reconcileCreditBalances();

    // The scoped bridge logs at error with a { scope } binding AND pages Sentry.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      {
        scope: "cron",
        alert: "REFUNDS_MISSING_XERO_CREDIT_NOTES",
        count: 1,
        graceHours: 24,
        samplePayments: [
          {
            paymentId: "pay_1",
            bookingId: "book_1",
            refundedAmountCents: 4200,
            refundedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
        href: "/admin/xero",
      },
      "1 refunded Stripe payment(s) are missing Xero refund credit notes"
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "1 refunded Stripe payment(s) are missing Xero refund credit notes",
      expect.objectContaining({
        level: "error",
        fingerprint: [
          "cron",
          "credit-reconciliation:refunds-missing-credit-notes",
        ],
      })
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      "jane@example.com"
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      "Jane Doe"
    );
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain(
      "jane@example.com"
    );
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain(
      "Jane Doe"
    );
  });

  it("re-enqueues the uncovered delta for each flagged payment so swallowed refunds self-heal (#1354)", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "booking_1",
          refundedAmountCents: 8000,
          refundedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          paymentId: "pay_2",
          bookingId: "booking_2",
          refundedAmountCents: 3000,
          refundedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    });
    mocks.isXeroConnected.mockResolvedValue(true);

    await reconcileCreditBalances();

    // The enqueue is delta-capped internally (covered cents are subtracted at
    // enqueue AND recomputed at execution), so passing the full refunded
    // total re-enqueues exactly the uncovered remainder; repeats collapse
    // into the existing PENDING operation via the correlation-key dedup.
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_1",
      8000
    );
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_2",
      3000
    );
    expect(
      mocks.kickQueuedXeroOutboxOperationsIfConnected
    ).toHaveBeenCalledWith({ limit: 2 });
  });

  it("continues healing the remaining payments when one enqueue fails", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "booking_1",
          refundedAmountCents: 8000,
          refundedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          paymentId: "pay_2",
          bookingId: "booking_2",
          refundedAmountCents: 3000,
          refundedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    });
    mocks.enqueueXeroRefundCreditNoteOperation
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ queueOperationId: "op_heal_2", message: "queued" });
    mocks.isXeroConnected.mockResolvedValue(true);

    await expect(reconcileCreditBalances()).resolves.toMatchObject({
      refundsMissingXeroCreditNotes: 2,
    });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledTimes(2);
    expect(
      mocks.kickQueuedXeroOutboxOperationsIfConnected
    ).toHaveBeenCalledWith({ limit: 1 });
  });

  it("keeps existing negative-balance discrepancy behavior", async () => {
    mocks.memberCreditGroupBy.mockResolvedValue([
      { memberId: "member-negative", _sum: { amountCents: -1000 } },
      { memberId: "member-positive", _sum: { amountCents: 2500 } },
    ]);

    const result = await reconcileCreditBalances();

    expect(result).toEqual({
      membersWithCredit: 1,
      totalCreditCents: 2500,
      discrepancies: 1,
      refundsMissingXeroCreditNotes: 0,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      {
        count: 1,
        memberIds: ["member-negative"],
      },
      "Members with negative credit balance detected"
    );
  });
});
