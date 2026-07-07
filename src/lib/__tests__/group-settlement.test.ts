import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

const mocks = vi.hoisted(() => ({
  groupBookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentUpsert: vi.fn(),
  settlementUpsert: vi.fn(),
  settlementFindUnique: vi.fn(),
  settlementFindFirst: vi.fn(),
  settlementUpdate: vi.fn(),
  settlementUpdateMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  transaction: vi.fn(),
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  checkCapacity: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  recordBookingEvent: vi.fn(),
  enqueueXeroInvoice: vi.fn(),
  enqueueSettlementInvoice: vi.fn(),
  kickXero: vi.fn(),
  loadModuleFlags: vi.fn(),
  sendSettlementReceipt: vi.fn(),
  sendJoinSettled: vi.fn(),
  lodgeFindFirst: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
}));

// The transaction client exposes the same nested method mocks; the callback runs
// synchronously against it so assertions can inspect every write.
const txClient = {
  $executeRaw: mocks.txExecuteRaw,
  lodge: { findFirst: mocks.lodgeFindFirst },
  booking: {
    findUnique: mocks.bookingFindUnique,
    findMany: mocks.bookingFindMany,
    update: mocks.bookingUpdate,
  },
  payment: { upsert: mocks.paymentUpsert },
  groupBookingSettlement: {
    findUnique: mocks.settlementFindUnique,
    update: mocks.settlementUpdate,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupBookingFindUnique },
    booking: { findMany: mocks.bookingFindMany },
    groupBookingSettlement: {
      upsert: mocks.settlementUpsert,
      findUnique: mocks.settlementFindUnique,
      findFirst: mocks.settlementFindFirst,
      update: mocks.settlementUpdate,
      updateMany: mocks.settlementUpdateMany,
    },
    internetBankingPaymentSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
  getPaymentIntent: mocks.getPaymentIntent,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntent,
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacity,
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroInvoice,
  enqueueXeroGroupSettlementInvoiceOperation: mocks.enqueueSettlementInvoice,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadModuleFlags,
}));
vi.mock("@/lib/email", () => ({
  sendGroupSettlementReceiptEmail: mocks.sendSettlementReceipt,
  sendGroupJoinSettledEmail: mocks.sendJoinSettled,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  createGroupSettlementIntent,
  applyGroupSettlementSucceeded,
  applyGroupSettlementSucceededFromInvoice,
  markGroupSettlementIntentFailed,
} from "@/lib/group-settlement";
import { GroupBookingError } from "@/lib/group-booking";

const ORGANISER = "organiser-1";
const ORG_BOOKING = "org-booking-1";
const GROUP_ID = "group-1";

function organiserPaysGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    organiserMemberId: ORGANISER,
    organiserBookingId: ORG_BOOKING,
    paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
    organiserMember: {
      id: ORGANISER,
      email: "org@example.com",
      firstName: "Olive",
      lastName: "Organiser",
    },
    organiserBooking: { checkIn: new Date("2026-07-01") },
    settlement: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The transaction callback runs against the shared txClient by default.
  mocks.transaction.mockImplementation(async (cb: (tx: typeof txClient) => unknown) =>
    cb(txClient)
  );
  mocks.txExecuteRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.enqueueXeroInvoice.mockResolvedValue({ queueOperationId: null });
  mocks.enqueueSettlementInvoice.mockResolvedValue({ queueOperationId: "op_settle_1" });
  mocks.kickXero.mockResolvedValue(undefined);
  mocks.loadModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  mocks.settlementUpsert.mockResolvedValue({ id: "settle-1", groupBookingId: GROUP_ID });
  mocks.settlementUpdateMany.mockResolvedValue({ count: 1 });
  mocks.findOrCreateCustomer.mockResolvedValue({ id: "cus_123" });
  mocks.createPaymentIntent.mockResolvedValue({
    id: "pi_settle_1",
    client_secret: "cs_settle_1",
  });
  mocks.sendSettlementReceipt.mockResolvedValue(undefined);
  mocks.sendJoinSettled.mockResolvedValue(undefined);
  mocks.cancelPaymentIntent.mockResolvedValue(null);
});

describe("createGroupSettlementIntent", () => {
  it("404s for an unknown code", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(null);
    await expect(createGroupSettlementIntent("NOPE2345", ORGANISER)).rejects.toMatchObject(
      { status: 404 }
    );
  });

  it("403s when the caller is not the organiser", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    await expect(
      createGroupSettlementIntent("ABCD2345", "someone-else")
    ).rejects.toMatchObject({ status: 403 });
  });

  it("409s for an each-pays-own group", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({ paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN })
    );
    await expect(
      createGroupSettlementIntent("ABCD2345", ORGANISER)
    ).rejects.toBeInstanceOf(GroupBookingError);
  });

  it("reports already_settled when a prior settlement succeeded", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: { status: PaymentStatus.SUCCEEDED, amountCents: 9000 },
      })
    );
    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);
    expect(result).toEqual({
      outcome: "already_settled",
      amountCents: 9000,
      childCount: 0,
    });
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("reports nothing_to_settle when there are no settleable children", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.bookingFindMany.mockResolvedValue([]);
    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);
    expect(result.outcome).toBe("nothing_to_settle");
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("commits children to CONFIRMED and opens one combined intent", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    // Inside the commit transaction each child re-reads as still PAYMENT_PENDING.
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });

    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(result.outcome).toBe("ready");
    expect(result.amountCents).toBe(9000);
    expect(result.childCount).toBe(2);
    expect(result.clientSecret).toBe("cs_settle_1");
    // Both children committed to CONFIRMED.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
      })
    );
    // One combined intent for the full total, tagged for the settlement webhook.
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 9000,
        metadata: expect.objectContaining({
          type: "group_settlement",
          groupBookingId: GROUP_ID,
        }),
      })
    );
    expect(mocks.settlementUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          stripePaymentIntentId: "pi_settle_1",
          amountCents: 9000,
          status: PaymentStatus.PENDING,
        }),
      })
    );
  });

  it("locks the CHILD's lodge, not the default, when committing children (H1)", async () => {
    // A group whose children live at a NON-default lodge. The capacity claim
    // (PAYMENT_PENDING -> CONFIRMED) must serialise under hash(childLodge), so
    // it contends with booking creators at that lodge; locking the default
    // lodge would leave them unserialised (overbooking race).
    const CHILD_LODGE = "lodge-child";
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" }); // default lodge
    mocks.bookingFindMany
      // 1) loadSettleableChildren
      .mockResolvedValueOnce([
        { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      ])
      // 2) commitChildrenToConfirmed's pre-lock lodge read
      .mockResolvedValueOnce([{ lodgeId: CHILD_LODGE }]);
    mocks.bookingFindUnique.mockResolvedValue({
      id: "child-1",
      lodgeId: CHILD_LODGE,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    });
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });

    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(result.outcome).toBe("ready");
    // The lodge is read from a dedicated pre-lock query keyed only on lodgeId.
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { lodgeId: true } })
    );
    // The advisory lock is keyed to the CHILD's lodge, never the default.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(txClient, CHILD_LODGE);
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalledWith(txClient, "lodge-1");
    // ...and the capacity check itself is scoped to the child's lodge.
    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      CHILD_LODGE,
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      [],
      "child-1",
      txClient
    );
  });

  it("aborts (409) and charges nothing when a child no longer fits", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockResolvedValue({
      id: "child-1",
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    });
    mocks.checkCapacity.mockResolvedValue({
      available: false,
      nightDetails: [{ date: new Date("2026-07-01"), availableBeds: -1 }],
    });

    await expect(
      createGroupSettlementIntent("ABCD2345", ORGANISER)
    ).rejects.toMatchObject({ status: 409, code: "CAPACITY_EXCEEDED" });
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("internet banking: commits children, enqueues one combined invoice, opens no Stripe intent", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });

    const result = await createGroupSettlementIntent(
      "ABCD2345",
      ORGANISER,
      "internet_banking"
    );

    expect(result.outcome).toBe("invoice_sent");
    expect(result.amountCents).toBe(9000);
    expect(result.childCount).toBe(2);
    expect(result.reference).toBe(`GROUP-${GROUP_ID.slice(0, 8).toUpperCase()}`);
    // Beds held: both children committed to CONFIRMED.
    expect(mocks.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
      })
    );
    // The settlement records the Internet Banking source, no Stripe intent.
    expect(mocks.settlementUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: PaymentSource.INTERNET_BANKING,
          amountCents: 9000,
          status: PaymentStatus.PENDING,
        }),
      })
    );
    // One combined invoice enqueued; never a Stripe PaymentIntent.
    expect(mocks.enqueueSettlementInvoice).toHaveBeenCalledWith("settle-1");
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("cancels the superseded card intent when a re-attempt opens a new one (issue #1016)", async () => {
    // A prior card attempt recorded pi_old for a different total; the party
    // changed, so this attempt creates a fresh intent and voids the old one.
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_old",
          amountCents: 8000,
        },
      })
    );
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });

    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(result.outcome).toBe("ready");
    expect(result.paymentIntentId).toBe("pi_settle_1");
    expect(mocks.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPaymentIntent).toHaveBeenCalledWith("pi_old");
  });

  it("does not cancel when Stripe idempotency returns the same intent id", async () => {
    // Same total: the recorded intent is canceled in Stripe, so the reuse branch
    // falls through and the amount-scoped idempotency key returns the same id.
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_settle_1",
          amountCents: 9000,
        },
      })
    );
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });
    mocks.getPaymentIntent.mockResolvedValue({
      id: "pi_settle_1",
      status: "canceled",
      client_secret: null,
    });

    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(result.outcome).toBe("ready");
    expect(mocks.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("a failed cancel of the superseded intent never breaks the settlement flow", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_old",
          amountCents: 8000,
        },
      })
    );
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });
    mocks.cancelPaymentIntent.mockRejectedValue(new Error("stripe unavailable"));

    const result = await createGroupSettlementIntent("ABCD2345", ORGANISER);

    // The webhook safety net is the backstop; the organiser can still pay.
    expect(result.outcome).toBe("ready");
    expect(result.clientSecret).toBe("cs_settle_1");
    expect(mocks.cancelPaymentIntent).toHaveBeenCalledWith("pi_old");
  });

  it("internet banking: rejects with 400 when the module is off (no beds held, no invoice)", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.loadModuleFlags.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: false,
    });

    await expect(
      createGroupSettlementIntent("ABCD2345", ORGANISER, "internet_banking")
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.enqueueSettlementInvoice).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  // Fix #1: the idempotency key is discriminated by the superseded intent id so a
  // re-settle at a previously-used amount within Stripe's 24h window cannot replay
  // a canceled prior intent.
  function settleableChildren() {
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
      { id: "child-2", finalPriceCents: 4500, status: BookingStatus.PAYMENT_PENDING },
    ]);
    mocks.bookingFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: [],
    }));
    mocks.checkCapacity.mockResolvedValue({ available: true, nightDetails: [] });
  }

  it("keys the intent with the _initial sentinel on a first-ever settle", async () => {
    mocks.groupBookingFindUnique.mockResolvedValue(organiserPaysGroup());
    settleableChildren();

    await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `groupsettle_${GROUP_ID}_9000_initial`,
      })
    );
  });

  it("keys the intent with the superseded intent id when a prior settlement exists", async () => {
    // Mismatched recorded amount (8000 != 9000 total) skips the reuse branch so a
    // fresh intent is minted and keyed by the prior intent id.
    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_old",
          amountCents: 8000,
        },
      })
    );
    settleableChildren();

    await createGroupSettlementIntent("ABCD2345", ORGANISER);

    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `groupsettle_${GROUP_ID}_9000_pi_old`,
      })
    );
  });

  it("mints different keys for the same amount when the superseded intent differs", async () => {
    settleableChildren();

    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_A",
          amountCents: 8000,
        },
      })
    );
    await createGroupSettlementIntent("ABCD2345", ORGANISER);

    mocks.groupBookingFindUnique.mockResolvedValue(
      organiserPaysGroup({
        settlement: {
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: "pi_B",
          amountCents: 8000,
        },
      })
    );
    await createGroupSettlementIntent("ABCD2345", ORGANISER);

    const keys = mocks.createPaymentIntent.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys).toEqual([
      `groupsettle_${GROUP_ID}_9000_pi_A`,
      `groupsettle_${GROUP_ID}_9000_pi_B`,
    ]);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("markGroupSettlementIntentFailed", () => {
  it("atomically moves only a non-terminal settlement to FAILED", async () => {
    await markGroupSettlementIntentFailed("pi_settle_1");

    // The guarded updateMany fuses the "still non-terminal?" check with the write,
    // so a racing succeeded/refunded settlement is never overwritten to FAILED.
    expect(mocks.settlementUpdateMany).toHaveBeenCalledWith({
      where: {
        stripePaymentIntentId: "pi_settle_1",
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.FAILED },
    });
    // No read-then-update: the plain findUnique/update path is gone.
    expect(mocks.settlementFindUnique).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
  });
});

describe("applyGroupSettlementSucceeded", () => {
  it("returns not_found when no settlement matches the intent", async () => {
    mocks.settlementFindUnique.mockResolvedValue(null);
    const result = await applyGroupSettlementSucceeded({ id: "pi_x", amount: 9000 });
    expect(result.outcome).toBe("not_found");
  });

  it("is idempotent for an already-succeeded settlement", async () => {
    mocks.settlementFindUnique.mockResolvedValue({
      id: "s1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 9000,
      groupBookingId: GROUP_ID,
      groupBooking: { organiserBookingId: ORG_BOOKING },
    });
    const result = await applyGroupSettlementSucceeded({ id: "pi_1", amount: 9000 });
    expect(result.outcome).toBe("already_settled");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses to apply when the paid amount does not match the recorded total", async () => {
    mocks.settlementFindUnique.mockResolvedValue({
      id: "s1",
      status: PaymentStatus.PENDING,
      amountCents: 9000,
      groupBookingId: GROUP_ID,
      groupBooking: { organiserBookingId: ORG_BOOKING },
    });
    const result = await applyGroupSettlementSucceeded({ id: "pi_1", amount: 8000 });
    expect(result.outcome).toBe("amount_mismatch");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses to apply when a child booking grew while the intent was open (#1033)", async () => {
    // The intent amount matches the recorded settlement (30000 === 30000),
    // but a joiner added a guest to their CONFIRMED child booking before the
    // organiser paid, so the children now cost more than the payment.
    mocks.settlementFindUnique
      .mockResolvedValueOnce({
        id: "s1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripeCustomerId: "cus_123",
        groupBookingId: GROUP_ID,
        groupBooking: {
          organiserBookingId: ORG_BOOKING,
          organiserMember: {
            email: "org@example.com",
            firstName: "Olive",
            lastName: "Organiser",
          },
          organiserBooking: { checkIn: new Date(), checkOut: new Date() },
        },
      })
      .mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany.mockResolvedValueOnce([
      { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      { id: "child-2", finalPriceCents: 12500, checkIn: new Date(), checkOut: new Date() },
    ]);

    const result = await applyGroupSettlementSucceeded({ id: "pi_1", amount: 9000 });

    expect(result.outcome).toBe("amount_mismatch");
    expect(result.settledBookingIds).toEqual([]);
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.sendSettlementReceipt).not.toHaveBeenCalled();
  });

  it("refuses to apply when a child booking shrank while the intent was open (#1033)", async () => {
    // Mirror case: a joiner reduced their child booking, so auto-applying
    // would make the organiser over-pay with no refund path.
    mocks.settlementFindUnique
      .mockResolvedValueOnce({
        id: "s1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripeCustomerId: "cus_123",
        groupBookingId: GROUP_ID,
        groupBooking: {
          organiserBookingId: ORG_BOOKING,
          organiserMember: {
            email: "org@example.com",
            firstName: "Olive",
            lastName: "Organiser",
          },
          organiserBooking: { checkIn: new Date(), checkOut: new Date() },
        },
      })
      .mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany.mockResolvedValueOnce([
      { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      { id: "child-2", finalPriceCents: 2500, checkIn: new Date(), checkOut: new Date() },
    ]);

    const result = await applyGroupSettlementSucceeded({ id: "pi_1", amount: 9000 });

    expect(result.outcome).toBe("amount_mismatch");
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
  });

  it("flips every confirmed child to PAID and records the settlement", async () => {
    mocks.settlementFindUnique
      // First call: top-level lookup by intent id (with organiser + dates).
      .mockResolvedValueOnce({
        id: "s1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripeCustomerId: "cus_123",
        groupBookingId: GROUP_ID,
        groupBooking: {
          organiserBookingId: ORG_BOOKING,
          organiserMember: {
            email: "org@example.com",
            firstName: "Olive",
            lastName: "Organiser",
          },
          organiserBooking: { checkIn: new Date(), checkOut: new Date() },
        },
      })
      // Second call: inside the lock, re-confirm still unpaid.
      .mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany
      // Inside the lock: the confirmed children to settle.
      .mockResolvedValueOnce([
        { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
        { id: "child-2", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      ])
      // After commit: the settled bookings re-loaded for the joiner emails.
      .mockResolvedValueOnce([
        {
          checkIn: new Date(),
          checkOut: new Date(),
          member: { email: "j1@example.com", firstName: "Jo" },
          _count: { guests: 1 },
        },
        {
          checkIn: new Date(),
          checkOut: new Date(),
          member: { email: "j2@example.com", firstName: "Sam" },
          _count: { guests: 2 },
        },
      ]);

    const result = await applyGroupSettlementSucceeded({ id: "pi_1", amount: 9000 });

    expect(result.outcome).toBe("settled");
    expect(result.settledBookingIds).toEqual(["child-1", "child-2"]);
    expect(mocks.paymentUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.paymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: PaymentSource.STRIPE,
          status: PaymentStatus.SUCCEEDED,
          reference: "pi_1",
        }),
      })
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.PAID }),
      })
    );
    expect(mocks.settlementUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.SUCCEEDED }),
      })
    );
    // Side effects per settled child.
    expect(mocks.recordBookingEvent).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueXeroInvoice).toHaveBeenCalledTimes(2);
    // Notifications: one organiser receipt + one confirmation per joiner.
    expect(mocks.sendSettlementReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.sendJoinSettled).toHaveBeenCalledTimes(2);
  });
});

describe("applyGroupSettlementSucceededFromInvoice", () => {
  it("returns not_found when no settlement matches the invoice", async () => {
    mocks.settlementFindFirst.mockResolvedValue(null);
    const result = await applyGroupSettlementSucceededFromInvoice("xinv_x");
    expect(result.outcome).toBe("not_found");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-succeeded settlement", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "s1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 9000,
      groupBookingId: GROUP_ID,
      groupBooking: { organiserBookingId: ORG_BOOKING },
    });
    const result = await applyGroupSettlementSucceededFromInvoice("xinv_1");
    expect(result.outcome).toBe("already_settled");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses to apply a paid invoice when a child booking changed while it was open (#1033)", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "s1",
      status: PaymentStatus.PENDING,
      amountCents: 9000,
      stripeCustomerId: null,
      xeroInvoiceId: "xinv_1",
      xeroInvoiceNumber: "INV-0042",
      groupBookingId: GROUP_ID,
      groupBooking: {
        organiserBookingId: ORG_BOOKING,
        organiserMember: {
          email: "org@example.com",
          firstName: "Olive",
          lastName: "Organiser",
        },
        organiserBooking: { checkIn: new Date(), checkOut: new Date() },
      },
    });
    mocks.settlementFindUnique.mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    // The children were repriced after the combined invoice was issued.
    mocks.bookingFindMany.mockResolvedValueOnce([
      { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      { id: "child-2", finalPriceCents: 9500, checkIn: new Date(), checkOut: new Date() },
    ]);

    const result = await applyGroupSettlementSucceededFromInvoice("xinv_1");

    expect(result.outcome).toBe("amount_mismatch");
    expect(result.settledBookingIds).toEqual([]);
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
  });

  it("flips every confirmed child to PAID with Internet Banking payments and no per-child invoices", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "s1",
      status: PaymentStatus.PENDING,
      amountCents: 9000,
      stripeCustomerId: null,
      xeroInvoiceId: "xinv_1",
      xeroInvoiceNumber: "INV-0042",
      groupBookingId: GROUP_ID,
      groupBooking: {
        organiserBookingId: ORG_BOOKING,
        organiserMember: {
          email: "org@example.com",
          firstName: "Olive",
          lastName: "Organiser",
        },
        organiserBooking: { checkIn: new Date(), checkOut: new Date() },
      },
    });
    // Inside the lock: re-confirm still unpaid.
    mocks.settlementFindUnique.mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany
      // Inside the lock: the confirmed children to settle.
      .mockResolvedValueOnce([
        { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
        { id: "child-2", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      ])
      // After commit: the settled bookings re-loaded for the joiner emails.
      .mockResolvedValueOnce([
        {
          checkIn: new Date(),
          checkOut: new Date(),
          member: { email: "j1@example.com", firstName: "Jo" },
          _count: { guests: 1 },
        },
        {
          checkIn: new Date(),
          checkOut: new Date(),
          member: { email: "j2@example.com", firstName: "Sam" },
          _count: { guests: 2 },
        },
      ]);

    const result = await applyGroupSettlementSucceededFromInvoice("xinv_1");

    expect(result.outcome).toBe("settled");
    expect(result.settledBookingIds).toEqual(["child-1", "child-2"]);
    expect(mocks.paymentUpsert).toHaveBeenCalledTimes(2);
    // Per-child payments carry the Internet Banking source + the invoice number.
    expect(mocks.paymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.SUCCEEDED,
          reference: "INV-0042",
        }),
      })
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingStatus.PAID }),
      })
    );
    expect(mocks.settlementUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.SUCCEEDED }),
      })
    );
    // The combined invoice already covers the group: no per-child Xero invoices.
    expect(mocks.enqueueXeroInvoice).not.toHaveBeenCalled();
    // Notifications still fire: organiser receipt + one per joiner.
    expect(mocks.sendSettlementReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.sendJoinSettled).toHaveBeenCalledTimes(2);
  });
});
