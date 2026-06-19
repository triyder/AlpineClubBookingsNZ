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
  settlementUpdate: vi.fn(),
  txExecuteRaw: vi.fn(),
  transaction: vi.fn(),
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
  checkCapacity: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  recordBookingEvent: vi.fn(),
  enqueueXeroInvoice: vi.fn(),
  kickXero: vi.fn(),
}));

// The transaction client exposes the same nested method mocks; the callback runs
// synchronously against it so assertions can inspect every write.
const txClient = {
  $executeRaw: mocks.txExecuteRaw,
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
      update: mocks.settlementUpdate,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
  getPaymentIntent: mocks.getPaymentIntent,
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacity,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroInvoice,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  createGroupSettlementIntent,
  applyGroupSettlementSucceeded,
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
  mocks.reconcileBedAllocations.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.enqueueXeroInvoice.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue(undefined);
  mocks.findOrCreateCustomer.mockResolvedValue({ id: "cus_123" });
  mocks.createPaymentIntent.mockResolvedValue({
    id: "pi_settle_1",
    client_secret: "cs_settle_1",
  });
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

  it("flips every confirmed child to PAID and records the settlement", async () => {
    mocks.settlementFindUnique
      // First call: top-level lookup by intent id.
      .mockResolvedValueOnce({
        id: "s1",
        status: PaymentStatus.PENDING,
        amountCents: 9000,
        stripeCustomerId: "cus_123",
        groupBookingId: GROUP_ID,
        groupBooking: { organiserBookingId: ORG_BOOKING },
      })
      // Second call: inside the lock, re-confirm still unpaid.
      .mockResolvedValueOnce({ status: PaymentStatus.PENDING });
    mocks.bookingFindMany.mockResolvedValue([
      { id: "child-1", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
      { id: "child-2", finalPriceCents: 4500, checkIn: new Date(), checkOut: new Date() },
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
  });
});
