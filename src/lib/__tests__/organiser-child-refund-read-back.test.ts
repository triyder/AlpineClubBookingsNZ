// #4130: the payments cron's organiser-child refund read-back is bounded as the
// card-refund read-back after it is (#4104): each read times out with no retries,
// and the sweep stops when its time budget is spent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refundFindMany: vi.fn(),
  refundUpdateMany: vi.fn(async () => ({ count: 1 })),
  transaction: vi.fn(async () => {
    throw new Error("deadlock");
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { paymentRefund: { findMany: mocks.refundFindMany, updateMany: mocks.refundUpdateMany }, $transaction: mocks.transaction },
}));

import type Stripe from "stripe";

import { READ_BACK_TIMEOUT_MS } from "@/lib/card-refund-status-sync";
import { reconcilePendingOrganiserChildRefunds } from "@/lib/organiser-child-refund-executor";

const row = (stripeRefundId: string) => ({ stripeRefundId, paymentId: "pay-child", status: "pending", stripePaymentIntentId: "pi_org" });
const unchanged = (id: string) => ({ id, status: "pending" }) as Stripe.Refund;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refundFindMany.mockResolvedValue([row("re_a"), row("re_b")]);
});

describe("reconcilePendingOrganiserChildRefunds (#4130)", () => {
  it("bounds every read with the shared read-back timeout and no retries", async () => {
    const retrieveRefund = vi.fn(async (id: string) => unchanged(id));
    expect(await reconcilePendingOrganiserChildRefunds({ retrieveRefund: retrieveRefund as never })).toEqual({ checked: 2, reversed: 0 });
    expect(retrieveRefund).toHaveBeenNthCalledWith(1, "re_a", { timeoutMs: READ_BACK_TIMEOUT_MS });
    expect(retrieveRefund).toHaveBeenNthCalledWith(2, "re_b", { timeoutMs: READ_BACK_TIMEOUT_MS });
  });

  it("reads the least recently read first, and stamps each one it read unchanged or could not read", async () => {
    const retrieveRefund = vi.fn(async (id: string) => {
      if (id === "re_b") throw new Error("timeout");
      return unchanged(id);
    });
    await reconcilePendingOrganiserChildRefunds({ retrieveRefund: retrieveRefund as never });
    expect(mocks.refundFindMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { updatedAt: "asc" } }));
    for (const id of ["re_a", "re_b"]) {
      expect(mocks.refundUpdateMany).toHaveBeenCalledWith({ where: { stripeRefundId: id, status: "pending" }, data: { updatedAt: expect.any(Date) } });
    }
  });

  it("a row whose record step throws is stamped and the sweep goes on to the next one", async () => {
    const retrieveRefund = vi.fn(async (id: string) => (id === "re_a" ? ({ id, status: "failed" } as Stripe.Refund) : unchanged(id)));
    expect(await reconcilePendingOrganiserChildRefunds({ retrieveRefund: retrieveRefund as never })).toEqual({ checked: 2, reversed: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(retrieveRefund).toHaveBeenCalledWith("re_b", { timeoutMs: READ_BACK_TIMEOUT_MS });
    expect(mocks.refundUpdateMany).toHaveBeenCalledWith({ where: { stripeRefundId: "re_a", status: "pending" }, data: { updatedAt: expect.any(Date) } });
  });

  it("reads nothing once its time budget is spent", async () => {
    const retrieveRefund = vi.fn(async (id: string) => unchanged(id));
    expect(await reconcilePendingOrganiserChildRefunds({ retrieveRefund: retrieveRefund as never }, 25, 0)).toEqual({ checked: 0, reversed: 0 });
    expect(retrieveRefund).not.toHaveBeenCalled();
  });

  it("a slow read that spends the budget stops the sweep before the next one", async () => {
    const now = vi.spyOn(performance, "now");
    let clock = 0;
    now.mockImplementation(() => clock);
    const retrieveRefund = vi.fn(async (id: string) => {
      clock += 5_000;
      return unchanged(id);
    });
    expect(await reconcilePendingOrganiserChildRefunds({ retrieveRefund: retrieveRefund as never }, 25, 5_000)).toEqual({ checked: 1, reversed: 0 });
    expect(retrieveRefund).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });
});
