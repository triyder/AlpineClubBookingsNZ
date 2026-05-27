import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingDelete: vi.fn(),
  bookingUpdate: vi.fn(),
  promoRedemptionDelete: vi.fn(),
  promoCodeUpdate: vi.fn(),
  paymentTransactionCount: vi.fn(),
  paymentRefundCount: vi.fn(),
  refundRequestCount: vi.fn(),
  memberCreditCount: vi.fn(),
  paymentRecoveryOperationCount: vi.fn(),
  xeroObjectLinkCount: vi.fn(),
  xeroSyncOperationCount: vi.fn(),
  prismaTransaction: vi.fn(),
  createAuditLog: vi.fn(),
}));

const mockTx = {
  booking: {
    findUnique: mocks.bookingFindUnique,
    delete: mocks.bookingDelete,
    update: mocks.bookingUpdate,
  },
  promoRedemption: {
    delete: mocks.promoRedemptionDelete,
  },
  promoCode: {
    update: mocks.promoCodeUpdate,
  },
  paymentTransaction: {
    count: mocks.paymentTransactionCount,
  },
  paymentRefund: {
    count: mocks.paymentRefundCount,
  },
  refundRequest: {
    count: mocks.refundRequestCount,
  },
  memberCredit: {
    count: mocks.memberCreditCount,
  },
  paymentRecoveryOperation: {
    count: mocks.paymentRecoveryOperationCount,
  },
  xeroObjectLink: {
    count: mocks.xeroObjectLinkCount,
  },
  xeroSyncOperation: {
    count: mocks.xeroSyncOperationCount,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      delete: mocks.bookingDelete,
      update: mocks.bookingUpdate,
    },
    promoRedemption: {
      delete: mocks.promoRedemptionDelete,
    },
    promoCode: {
      update: mocks.promoCodeUpdate,
    },
    paymentTransaction: {
      count: mocks.paymentTransactionCount,
    },
    paymentRefund: {
      count: mocks.paymentRefundCount,
    },
    refundRequest: {
      count: mocks.refundRequestCount,
    },
    memberCredit: {
      count: mocks.memberCreditCount,
    },
    paymentRecoveryOperation: {
      count: mocks.paymentRecoveryOperationCount,
    },
    xeroObjectLink: {
      count: mocks.xeroObjectLinkCount,
    },
    xeroSyncOperation: {
      count: mocks.xeroSyncOperationCount,
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

import { deleteBooking } from "@/lib/booking-delete";

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    checkIn: new Date("2026-07-10T00:00:00.000Z"),
    checkOut: new Date("2026-07-12T00:00:00.000Z"),
    status: "DRAFT",
    totalPriceCents: 10000,
    discountCents: 1000,
    finalPriceCents: 9000,
    hasNonMembers: false,
    draftExpiresAt: new Date("2026-05-30T00:00:00.000Z"),
    deletedAt: null,
    deletedById: null,
    createdAt: new Date("2026-05-27T00:00:00.000Z"),
    updatedAt: new Date("2026-05-27T01:00:00.000Z"),
    promoRedemption: null,
    guests: [],
    payment: null,
    modifications: [],
    _count: {
      guests: 2,
      changeRequests: 0,
      refundRequests: 0,
      paymentRecoveryOperations: 0,
    },
    ...overrides,
  };
}

describe("deleteBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prismaTransaction.mockImplementation(
      async (callback: (tx: typeof mockTx) => unknown | Promise<unknown>) =>
        callback(mockTx)
    );
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.bookingDelete.mockResolvedValue({});
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.promoRedemptionDelete.mockResolvedValue({});
    mocks.promoCodeUpdate.mockResolvedValue({});
    mocks.paymentTransactionCount.mockResolvedValue(0);
    mocks.paymentRefundCount.mockResolvedValue(0);
    mocks.refundRequestCount.mockResolvedValue(0);
    mocks.memberCreditCount.mockResolvedValue(0);
    mocks.paymentRecoveryOperationCount.mockResolvedValue(0);
    mocks.xeroObjectLinkCount.mockResolvedValue(0);
    mocks.xeroSyncOperationCount.mockResolvedValue(0);
  });

  it("hard-deletes an owned draft after durable audit and promo cleanup", async () => {
    const draft = makeBooking({
      promoRedemption: {
        id: "redemption-1",
        promoCodeId: "promo-1",
        discountCents: 1000,
        freeNightsUsed: null,
        eligibleGuestCount: 1,
      },
    });
    mocks.bookingFindUnique.mockResolvedValue(draft);

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "member-1", role: "MEMBER", ipAddress: "127.0.0.1" },
    });

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        mode: "hard-delete",
        bookingId: "booking-1",
        message: "Draft booking deleted",
      },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.delete.draft",
        targetId: "booking-1",
        severity: "critical",
        metadata: expect.objectContaining({
          mode: "hard-delete",
          booking: expect.objectContaining({
            id: "booking-1",
            promoRedemption: expect.objectContaining({ id: "redemption-1" }),
          }),
        }),
      }),
      mockTx
    );
    expect(mocks.promoRedemptionDelete).toHaveBeenCalledWith({
      where: { id: "redemption-1" },
    });
    expect(mocks.promoCodeUpdate).toHaveBeenCalledWith({
      where: { id: "promo-1" },
      data: { currentRedemptions: { decrement: 1 } },
    });
    expect(mocks.bookingDelete).toHaveBeenCalledWith({
      where: { id: "booking-1" },
    });
    expect(mocks.createAuditLog.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bookingDelete.mock.invocationCallOrder[0]
    );
  });

  it("soft-deletes an eligible cancelled booking with a critical audit event", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({ status: "CANCELLED", draftExpiresAt: null })
    );

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "admin-1", role: "ADMIN", ipAddress: "127.0.0.1" },
      reason: "Duplicate test booking",
    });

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        mode: "soft-delete",
        bookingId: "booking-1",
        message: "Cancelled booking deleted",
      },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.delete.cancelled.soft",
        memberId: "admin-1",
        severity: "critical",
        details: "Duplicate test booking",
      }),
      mockTx
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: {
        deletedAt: expect.any(Date),
        deletedById: "admin-1",
        deletedReason: "Duplicate test booking",
      },
    });
  });

  it("returns blocker details for cancelled bookings with financial or Xero history", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        status: "CANCELLED",
        draftExpiresAt: null,
        payment: {
          id: "payment-1",
          status: "SUCCEEDED",
          amountCents: 10000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_1",
          additionalPaymentIntentId: null,
          xeroInvoiceId: "inv-1",
          xeroInvoiceNumber: "INV-1",
          xeroRefundCreditNoteId: null,
        },
        modifications: [
          {
            id: "mod-1",
            modificationType: "DATE_CHANGE",
            priceDiffCents: 500,
            changeFeeCents: 0,
            createdAt: new Date("2026-05-27T02:00:00.000Z"),
          },
        ],
      })
    );
    mocks.paymentTransactionCount.mockResolvedValue(1);
    mocks.memberCreditCount.mockResolvedValue(1);
    mocks.xeroSyncOperationCount.mockResolvedValue(1);

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "admin-1", role: "ADMIN" },
      reason: "Duplicate test booking",
    });

    expect(result.status).toBe(409);
    expect(result).toMatchObject({
      error:
        "Cancelled booking cannot be deleted because financial or Xero history exists",
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "payment_record" }),
        expect.objectContaining({ code: "captured_payment" }),
        expect.objectContaining({ code: "payment_transaction" }),
        expect.objectContaining({ code: "member_credit" }),
        expect.objectContaining({ code: "xero_payment_reference" }),
        expect.objectContaining({ code: "xero_sync_operation" }),
        expect.objectContaining({ code: "financial_modification" }),
      ]),
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("prevents members from deleting cancelled bookings", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({ status: "CANCELLED", draftExpiresAt: null })
    );

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "member-1", role: "MEMBER" },
      reason: "Duplicate test booking",
    });

    expect(result).toEqual({
      status: 403,
      error: "Only admins can delete cancelled bookings",
    });
  });

  it("prevents members from deleting someone else's draft", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "member-2", role: "MEMBER" },
    });

    expect(result).toEqual({ status: 403, error: "Forbidden" });
    expect(mocks.prismaTransaction).not.toHaveBeenCalled();
  });
});
