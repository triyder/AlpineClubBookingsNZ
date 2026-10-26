// #4104 (`INV-PAY-128`): the two ways a card refund's failure reaches the
// ledger writer - the refund-failed webhook and the payments cron's read-back.
// The writer itself, and the debt it keeps, are proven in
// `payment-transactions-refunds.test.ts`, `card-refund-failed-later.test.ts`
// and `card-refund-failed-later.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refundFindUnique: vi.fn(),
  refundFindMany: vi.fn(),
  refundUpdateMany: vi.fn(async () => ({ count: 1 })),
  findTransaction: vi.fn(),
  record: vi.fn(async () => ({})),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRefund: { findUnique: mocks.refundFindUnique, findMany: mocks.refundFindMany, updateMany: mocks.refundUpdateMany },
  },
}));
vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: mocks.findTransaction,
  recordStripeRefundsAgainstTransaction: mocks.record,
}));
vi.mock("@/lib/stripe", () => ({ retrieveRefund: vi.fn() }));

import type Stripe from "stripe";

import { reconcilePendingCardRefunds, recordRefusedCardRefund } from "@/lib/card-refund-status-sync";

const refund = (status: string, extra: Partial<Stripe.Refund> = {}) =>
  ({ id: "re_1", amount: 4_000, currency: "nzd", status, payment_intent: "pi_1", charge: "ch_1", ...extra }) as Stripe.Refund;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refundFindUnique.mockResolvedValue(null);
  mocks.findTransaction.mockResolvedValue({ id: "txn-1", paymentId: "pay-1" });
});

describe("the refund-failed webhook's recorder", () => {
  it.each(["pending", "succeeded", "requires_action"])("records nothing for a refund Stripe reports %s: that is the charge.refunded sync's", async (status) => {
    expect(await recordRefusedCardRefund(refund(status))).toBe("not-refused");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(["failed", "canceled"])("records a %s refund it already holds against its own charge", async (status) => {
    mocks.refundFindUnique.mockResolvedValue({ paymentId: "pay-1", paymentTransactionId: "txn-1", stripePaymentIntentId: "pi_1" });
    expect(await recordRefusedCardRefund(refund(status))).toBe("recorded");
    expect(mocks.record).toHaveBeenCalledWith({
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      refunds: [refund(status)],
      fallbackChargeId: "ch_1",
      fallbackPaymentIntentId: "pi_1",
    });
    expect(mocks.findTransaction).not.toHaveBeenCalled();
  });

  it("records a refund it has not seen yet against the charge its intent names (the event arrived first)", async () => {
    expect(await recordRefusedCardRefund(refund("failed"))).toBe("recorded");
    expect(mocks.findTransaction).toHaveBeenCalledWith({ paymentIntentId: "pi_1" });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay-1", paymentTransactionId: "txn-1" }));
  });

  it("leaves an unknown refund on an unknown payment alone", async () => {
    mocks.findTransaction.mockResolvedValue(null);
    expect(await recordRefusedCardRefund(refund("failed"))).toBe("not-a-card-payment");
    expect(await recordRefusedCardRefund(refund("failed", { payment_intent: null }))).toBe("not-a-card-payment");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("leaves an organiser child's refund (no charge of its own) to its own read-back (INV-PAY-114)", async () => {
    mocks.refundFindUnique.mockResolvedValue({ paymentId: "pay-child", paymentTransactionId: null, stripePaymentIntentId: "pi_combined" });
    expect(await recordRefusedCardRefund(refund("failed"))).toBe("not-a-card-payment");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("lets a write failure through, so the webhook answers 500 and Stripe sends it again", async () => {
    mocks.record.mockRejectedValueOnce(new Error("recovery mid-attempt"));
    await expect(recordRefusedCardRefund(refund("failed"))).rejects.toThrow("recovery mid-attempt");
  });
});

describe("the payments cron's read-back", () => {
  const row = (id: string, status = "pending") => ({
    stripeRefundId: id,
    paymentId: "pay-1",
    paymentTransactionId: "txn-1",
    status,
    stripePaymentIntentId: "pi_1",
  });

  it("reads only card refunds neither made nor refused, least recently read first", async () => {
    mocks.refundFindMany.mockResolvedValue([]);
    await reconcilePendingCardRefunds({ retrieveRefund: vi.fn() }, 25);
    expect(mocks.refundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentTransactionId: { not: null }, status: { notIn: ["failed", "canceled", "succeeded"] } },
        orderBy: { updatedAt: "asc" },
        take: 25,
      }),
    );
  });

  it("records one whose status moved, stamps one still pending, and carries on past one it cannot read", async () => {
    mocks.refundFindMany.mockResolvedValue([row("re_failed"), row("re_still"), row("re_unreadable"), row("re_made")]);
    const retrieveRefund = vi.fn(async (id: string) => {
      if (id === "re_unreadable") throw new Error("Stripe down");
      if (id === "re_failed") return refund("failed", { id });
      if (id === "re_made") return refund("succeeded", { id });
      return refund("pending", { id });
    });
    expect(await reconcilePendingCardRefunds({ retrieveRefund: retrieveRefund as never })).toEqual({ checked: 4, moved: 2 });
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1", paymentTransactionId: "txn-1", refunds: [expect.objectContaining({ id: "re_failed", status: "failed" })] }),
    );
    // The one still pending, and the one it could not read (ops 9), are stamped, so
    // the next run reads others first; guarded on the status it read.
    expect(mocks.refundUpdateMany).toHaveBeenCalledTimes(2);
    for (const id of ["re_still", "re_unreadable"]) {
      expect(mocks.refundUpdateMany).toHaveBeenCalledWith({ where: { stripeRefundId: id, status: "pending" }, data: { updatedAt: expect.any(Date) } });
    }
    // Each read bounded, with no retries (`retrieveRefund`'s sweep option).
    expect(retrieveRefund).toHaveBeenCalledWith("re_failed", { timeoutMs: 10_000 });
  });

  it("stops when its time budget is spent", async () => {
    mocks.refundFindMany.mockResolvedValue([row("re_a"), row("re_b")]);
    const retrieveRefund = vi.fn(async (id: string) => refund("pending", { id }));
    expect(await reconcilePendingCardRefunds({ retrieveRefund: retrieveRefund as never }, 25, 0)).toEqual({ checked: 0, moved: 0 });
    expect(retrieveRefund).not.toHaveBeenCalled();
  });
});
