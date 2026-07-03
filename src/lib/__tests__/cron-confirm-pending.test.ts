import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Stripe
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

const mockChargePaymentMethod = vi.fn();
const mockMarkBookingPaymentSucceeded = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({
  queueOperationId: "op_1",
  message: "queued",
});
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue({
  found: 1,
  processed: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
});
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
}));
vi.mock("../xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("../payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
}));

vi.mock("../payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));

vi.mock("../waitlist", () => ({
  processWaitlistForDates: vi.fn().mockResolvedValue(undefined),
}));

// Mock email
const mockSendConfirmedEmail = vi.fn();
const mockSendBumpedEmail = vi.fn();
const mockSendGuestsRemovedEmail = vi.fn();
const mockSendGuestsCancelledEmail = vi.fn();
const mockSendAdminPaymentFailureAlert = vi.fn().mockResolvedValue(undefined);
const mockSendAdminHoldExpiredAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("../email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendConfirmedEmail(...args),
  sendBookingBumpedEmail: (...args: unknown[]) => mockSendBumpedEmail(...args),
  sendBookingGuestsRemovedEmail: (...args: unknown[]) => mockSendGuestsRemovedEmail(...args),
  sendBookingGuestsCancelledEmail: (...args: unknown[]) => mockSendGuestsCancelledEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendAdminBookingRequestHoldExpiredEmail: (...args: unknown[]) =>
    mockSendAdminHoldExpiredAlert(...args),
}));

// The confirm-pending cron revokes payment links for bumped bookings
// (issue #707); the behaviour itself is covered in payment-link.test.ts.
const mockRevokePaymentLinksForBooking = vi.fn().mockResolvedValue(0);
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: (...args: unknown[]) =>
    mockRevokePaymentLinksForBooking(...args),
}));

// Mock promo cleanup used by the whole-bump path.
const mockDeletePromoRedemption = vi.fn().mockResolvedValue(undefined);
vi.mock("../promo", () => ({
  deletePromoRedemptionAndAdjustCount: (...args: unknown[]) =>
    mockDeletePromoRedemption(...args),
}));

// Mock capacity
const mockCheckCapacityForGuestRanges = vi.fn();
vi.mock("../capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mockCheckCapacityForGuestRanges(...args),
  LODGE_CAPACITY: 29,
}));

// Mock Prisma
const mockBookingFindMany = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockPaymentUpsert = vi.fn();
const mockPromoRedemptionFindUnique = vi.fn();
const mockPrismaTransaction = vi.fn();
const mockExecuteRaw = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    payment: {
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
      upsert: (...args: unknown[]) => mockPaymentUpsert(...args),
    },
    promoRedemption: {
      findUnique: (...args: unknown[]) => mockPromoRedemptionFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
  },
}));

const { confirmPendingBookings } = await import("../cron-confirm-pending");

function makePendingBooking(
  id: string,
  opts: {
    checkIn?: string;
    checkOut?: string;
    guestCount?: number;
    holdUntil?: string;
    hasPaymentMethod?: boolean;
    finalPriceCents?: number;
    parentBookingId?: string | null;
    parentPayment?: {
      id: string;
      stripePaymentMethodId: string;
      stripeCustomerId: string;
    } | null;
    originBookingRequest?: { id: string } | null;
  } = {}
) {
  const {
    checkIn = "2026-07-15",
    checkOut = "2026-07-17",
    guestCount = 2,
    holdUntil = "2026-07-08",
    hasPaymentMethod = true,
    finalPriceCents = 10000,
    parentBookingId = null,
    parentPayment = null,
    originBookingRequest = null,
  } = opts;
  const stayStart = new Date(checkIn);
  const stayEnd = new Date(checkOut);

  return {
    id,
    memberId: `member_${id}`,
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    status: "PENDING",
    finalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    nonMemberHoldUntil: new Date(holdUntil),
    hasNonMembers: true,
    cancelIfGuestsBumped: false,
    parentBookingId,
    parentBooking: parentPayment
      ? {
          id: parentBookingId ?? `parent_${id}`,
          payment: parentPayment,
        }
      : null,
    originBookingRequest,
    promoRedemption: null,
    createdAt: new Date("2026-03-01"),
    member: {
      id: `member_${id}`,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
    },
    guests: Array.from({ length: guestCount }, (_, i) => ({
      id: `guest_${id}_${i}`,
      bookingId: id,
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT",
      isMember: false,
      memberId: null as string | null,
      stayStart,
      stayEnd,
      priceCents: 5000,
    })),
    payment: hasPaymentMethod
      ? {
          id: `pay_${id}`,
          bookingId: id,
          stripePaymentMethodId: `pm_${id}`,
          stripeCustomerId: `cus_${id}`,
          stripeSetupIntentId: `seti_${id}`,
          amountCents: finalPriceCents,
          status: "PENDING",
        }
      : null,
  };
}

function mockPendingBookings(bookings: ReturnType<typeof makePendingBooking>[]) {
  mockBookingFindMany.mockResolvedValue(bookings);
  mockBookingFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      bookings.find((booking) => booking.id === where.id) ?? null
  );
}

describe("Cron: Confirm Pending Bookings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T00:00:00.000Z"));
    vi.clearAllMocks();
    mockEnqueueXeroBookingInvoiceOperation.mockResolvedValue({
      queueOperationId: "op_1",
      message: "queued",
    });
    mockKickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentUpsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { bookingId: string };
        create?: { id?: string };
      }) => ({
        id: create?.id ?? `pay_${where.bookingId}`,
      })
    );
    mockPromoRedemptionFindUnique.mockResolvedValue(null);
    mockDeletePromoRedemption.mockResolvedValue(undefined);
    mockRevokePaymentLinksForBooking.mockResolvedValue(0);
    mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
          booking: {
            findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
            update: (...args: unknown[]) => mockBookingUpdate(...args),
            updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
          },
          payment: {
            upsert: (...args: unknown[]) => mockPaymentUpsert(...args),
          },
          promoRedemption: {
            findUnique: (...args: unknown[]) =>
              mockPromoRedemptionFindUnique(...args),
          },
        });
      }

      return Promise.all(arg as Promise<unknown>[]);
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "b1",
      bumpedBookingIds: [],
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries all expired provisional bookings in oldest-first order, including split children", async () => {
    mockPendingBookings([]);

    await confirmPendingBookings();

    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          parentBookingId: expect.anything(),
        }),
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("confirms a booking when capacity is available and payment succeeds", async () => {
    const booking = makePendingBooking("b1");
    const expectedIdempotencyKey = ["pending", "charge", "b1"].join("_");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    expect(mockChargePaymentMethod).toHaveBeenCalledWith({
      amountCents: 10000,
      customerId: "cus_b1",
      paymentMethodId: "pm_b1",
      metadata: { bookingId: "b1", memberId: "member_b1" },
      idempotencyKey: expectedIdempotencyKey,
    });

    expect(mockSendConfirmedEmail).toHaveBeenCalledWith(
      "b1@example.com",
      "Test",
      booking.checkIn,
      booking.checkOut,
      2,
      10000,
      undefined
    );
  });

  it("charges a split non-member child using the parent booking's saved card", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
      },
      finalPriceCents: 12000,
      guestCount: 1,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 3,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_child_1",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_parent_1",
    });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["child_1"]);
    expect(mockPaymentUpsert).toHaveBeenCalledWith({
      where: { bookingId: "child_1" },
      create: expect.objectContaining({
        bookingId: "child_1",
        amountCents: 12000,
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
      }),
      update: expect.objectContaining({
        amountCents: 12000,
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
      }),
    });
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12000,
        customerId: "cus_parent_1",
        paymentMethodId: "pm_parent_1",
        metadata: { bookingId: "child_1", memberId: "member_child_1" },
      })
    );
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("child_1");
  });

  it("cancels a split non-member child without charge or invoice when capacity is gone", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
      },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["child_1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "child_1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("does not charge when another worker already claimed the expired booking", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.failedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("bumps a booking when capacity is not available", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);

    // R3 cancels the unresolved provisional booking without charging it.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });

    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
    expect(mockSendBumpedEmail).toHaveBeenCalled();
  });

  it("fails gracefully when no payment method is saved", async () => {
    const booking = makePendingBooking("b1", { hasPaymentMethod: false });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("processes multiple bookings independently", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockPendingBookings([booking1, booking2]);

    // b1: available, payment succeeds
    // b2: not available, bump
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] })
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] });

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toEqual(["b2"]);
  });

  it("handles Stripe charge failure gracefully", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockRejectedValue(new Error("Card declined"));

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
  });

  it("handles payment in processing state (requires_action)", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "requires_action",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    // Not confirmed yet (waiting for webhook), not failed
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_b1",
        paymentIntentId: "pi_auto_1",
        amountCents: 10000,
        status: "PROCESSING",
      })
    );
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: booking.nonMemberHoldUntil,
      },
    });
  });

  it("does nothing when no pending bookings are past hold deadline", async () => {
    mockPendingBookings([]);

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);
    expect(mockCheckCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("continues processing remaining bookings when one fails", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockPendingBookings([booking1, booking2]);

    mockCheckCapacityForGuestRanges
      .mockRejectedValueOnce(new Error("DB error")) // b1 fails
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] }); // b2 succeeds

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_2",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toEqual(["b2"]);
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("passes guest stay ranges and booking ID to range capacity as excludeBookingId", async () => {
    const booking = makePendingBooking("b1", { guestCount: 3 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    await confirmPendingBookings();

    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      "b1",
      expect.objectContaining({})
    );
  });

  it("continues when Xero invoice queueing fails during pending confirmation", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero unavailable"));

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("b1");
  });

  it("does not revert or alert when local persistence fails after Stripe already succeeded", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValueOnce(
      new Error("Payment update failed")
    );

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CONFIRMED", nonMemberHoldUntil: null },
    });
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: booking.nonMemberHoldUntil,
      },
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  // --- issue #737: no partial bump or reduced members-only charge at hold
  // expiry. Members pay up front, so a PENDING booking that no longer fits is
  // bumped whole (the bump-on-no-capacity safety). The synchronous
  // most-recent-first / partial bump in bumping.ts is unchanged (#708) and
  // covered in bumping.test.ts. ---

  function makeMixedPendingBooking(
    opts: {
      id?: string;
      cancelIfGuestsBumped?: boolean;
      hasPaymentMethod?: boolean;
      finalPriceCents?: number;
    } = {}
  ) {
    const {
      id = "b1",
      cancelIfGuestsBumped = false,
      hasPaymentMethod = true,
      finalPriceCents = 18000,
    } = opts;
    const base = makePendingBooking(id, { hasPaymentMethod, finalPriceCents });
    base.guests = [
      {
        id: `${id}_m0`,
        bookingId: id,
        firstName: "Member",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: true,
        memberId: `mem_${id}`,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 8000,
      },
      {
        id: `${id}_n0`,
        bookingId: id,
        firstName: "NonMember",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 10000,
      },
    ];
    return { ...base, cancelIfGuestsBumped };
  }

  it("cancels the whole booking when the cancel-if-guests-bumped flag is set", async () => {
    const booking = makeMixedPendingBooking({ cancelIfGuestsBumped: true });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockSendGuestsCancelledEmail).toHaveBeenCalled();
    expect(mockSendBumpedEmail).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("whole-bumps a mixed booking at hold expiry without charging a reduced members-only amount", async () => {
    const booking = makeMixedPendingBooking({ finalPriceCents: 18000 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // No reduced members-only charge (issue #737).
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    // A regular (unflagged) bump sends the bumped email, not guests-cancelled.
    expect(mockSendBumpedEmail).toHaveBeenCalled();
    expect(mockSendGuestsCancelledEmail).not.toHaveBeenCalled();
  });

  it("whole-bumps a no-card mixed booking at hold expiry instead of repricing it", async () => {
    const booking = makeMixedPendingBooking({ hasPaymentMethod: false, finalPriceCents: 18000 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Never routed to PAYMENT_PENDING (the old reprice-and-owe path is gone).
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING" },
    });
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
  });

  it("extends the hold and alerts admins for a request-origin booking, never charging it (#707)", async () => {
    const booking = makePendingBooking("b1", {
      hasPaymentMethod: false,
      originBookingRequest: { id: "req_1" },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // Request-origin bookings pay via a tokenised link, never a saved card.
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Hold extended via the status-claim; booking stays PENDING (not failed).
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "b1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(result.failedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(mockSendAdminHoldExpiredAlert).toHaveBeenCalled();
  });

  it("cancels and revokes the payment link for a request-origin booking when capacity is gone (#707/#708)", async () => {
    const booking = makePendingBooking("b1", {
      hasPaymentMethod: false,
      originBookingRequest: { id: "req_1" },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockRevokePaymentLinksForBooking).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({})
    );
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });
});
