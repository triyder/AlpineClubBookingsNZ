import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroSyncCursor: { findUnique: vi.fn() },
    memberCredit: { findMany: vi.fn() },
    paymentRecoveryOperation: { findMany: vi.fn() },
    payment: { findFirst: vi.fn() },
  },
  enqueue: vi.fn(),
  record: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/payment-recovery", () => ({ enqueueAdditionalPaymentIntentRecovery: mocks.enqueue }));
vi.mock("@/lib/credit-release-xero-payment", () => ({ recordCreditReleasePayments: mocks.record }));
vi.mock("@/lib/credit-release-ask-close", () => ({ closeCreditReleaseAsksPaidInXero: mocks.close }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  CREDIT_RELEASE_SETTLE_WINDOW_MS,
  creditReleaseAskWriterSince,
  enqueueCreditReleaseAsks,
  runCreditReleaseAskSweep,
} from "@/lib/credit-release-ask-sweep";
import {
  buildCreditReleaseAskRecoveryIdempotencyKey,
  buildCreditReleaseAskStripeIdempotencyKey,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): the sweep's switch, its enqueue and its error isolation.
  Time is the frozen test clock (2026-07-01); the settle window is measured from it.
*/
const NOW = new Date("2026-07-01T00:00:00.000Z");
const SINCE = new Date("2026-06-30T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(null);
  mocks.prisma.memberCredit.findMany.mockResolvedValue([]);
  mocks.prisma.paymentRecoveryOperation.findMany.mockResolvedValue([]);
  mocks.prisma.payment.findFirst.mockResolvedValue({ id: "pay-1" });
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue({ recorded: 0, held: 0, failed: 0, waiting: 0 });
  mocks.close.mockResolvedValue({ closed: 0, left: 0 });
});

describe("creditReleaseAskWriterSince", () => {
  const CREATED = new Date("2026-06-30T00:00:00.000Z");
  it.each([
    ["no row", null, null],
    ["enabled true", { metadata: { enabled: true }, createdAt: CREATED }, CREATED],
    ["enabled the string true", { metadata: { enabled: "true" }, createdAt: CREATED }, null],
    ["enabled false", { metadata: { enabled: false }, createdAt: CREATED }, null],
    ["no metadata", { metadata: null, createdAt: CREATED }, null],
    ["array metadata", { metadata: [true], createdAt: CREATED }, null],
  ])("%s", async (_name, row, expected) => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue(row);
    expect(await creditReleaseAskWriterSince()).toEqual(expected);
  });
});

describe("enqueueCreditReleaseAsks", () => {
  const release = { id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" };

  it("only looks at releases older than the settle window", async () => {
    await enqueueCreditReleaseAsks({ now: NOW, since: SINCE });
    const where = mocks.prisma.memberCredit.findMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt).toEqual(new Date(NOW.getTime() - CREDIT_RELEASE_SETTLE_WINDOW_MS));
    // Releases from before the switch row existed are the backlog, which is release 2's run.
    expect(where.createdAt.gte).toEqual(SINCE);
    expect(where.outsideSpendConvergedAt).toEqual({ not: null });
    expect(where.amountCents).toEqual({ gt: 0 });
  });

  it("enqueues one recovery row per release under the release-named key, with no supplementary invoice", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      bookingId: "bk-1",
      paymentId: "pay-1",
      idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1"),
      amountCents: 4000,
      stripeIdempotencyKey: buildCreditReleaseAskStripeIdempotencyKey("rel-1"),
      hadIssuedXeroInvoice: false,
    });
  });

  it("never looks at the same release twice", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    mocks.prisma.paymentRecoveryOperation.findMany.mockResolvedValue([
      { idempotencyKey: buildCreditReleaseAskRecoveryIdempotencyKey("rel-1") },
    ]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips a release whose booking has no payment row", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([release]);
    mocks.prisma.payment.findFirst.mockResolvedValue(null);
    expect(await enqueueCreditReleaseAsks({ now: NOW, since: SINCE })).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("stops at the limit", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([
      release,
      { ...release, id: "rel-2" },
      { ...release, id: "rel-3" },
    ]);
    expect(await enqueueCreditReleaseAsks({ now: NOW, limit: 2, since: SINCE })).toBe(2);
  });
});

describe("runCreditReleaseAskSweep", () => {
  it("raises nothing while the writer switch is off, but still records and closes", async () => {
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    const result = await runCreditReleaseAskSweep();
    expect(result.enqueued).toBe(0);
    expect(mocks.prisma.memberCredit.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("enqueues once the switch is on", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({ metadata: { enabled: true }, createdAt: SINCE });
    mocks.prisma.memberCredit.findMany.mockResolvedValue([{ id: "rel-1", amountCents: 4000, appliedToBookingId: "bk-1" }]);
    const result = await runCreditReleaseAskSweep();
    expect(result.enqueued).toBe(1);
  });

  it("a failing step never stops the next, and the sweep still reports the failure", async () => {
    mocks.record.mockRejectedValue(new Error("xero down"));
    await expect(runCreditReleaseAskSweep()).rejects.toThrow(/1 credit-release sweep step/);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
