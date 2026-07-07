import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingDelete: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingChangeRequestDeleteMany: vi.fn(),
  bookingModificationDeleteMany: vi.fn(),
  bookingEventDeleteMany: vi.fn(),
  promoRedemptionDelete: vi.fn(),
  promoRedemptionAllocationCount: vi.fn(),
  promoCodeUpdate: vi.fn(),
  paymentTransactionCount: vi.fn(),
  paymentRefundCount: vi.fn(),
  refundRequestCount: vi.fn(),
  memberCreditFindMany: vi.fn(),
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
  bookingChangeRequest: {
    deleteMany: mocks.bookingChangeRequestDeleteMany,
  },
  bookingModification: {
    deleteMany: mocks.bookingModificationDeleteMany,
  },
  bookingEvent: {
    deleteMany: mocks.bookingEventDeleteMany,
  },
  promoRedemption: {
    delete: mocks.promoRedemptionDelete,
  },
  promoRedemptionAllocation: {
    count: mocks.promoRedemptionAllocationCount,
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
    findMany: mocks.memberCreditFindMany,
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
    bookingChangeRequest: {
      deleteMany: mocks.bookingChangeRequestDeleteMany,
    },
    bookingModification: {
      deleteMany: mocks.bookingModificationDeleteMany,
    },
    promoRedemption: {
      delete: mocks.promoRedemptionDelete,
    },
    promoRedemptionAllocation: {
      count: mocks.promoRedemptionAllocationCount,
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
      findMany: mocks.memberCreditFindMany,
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
    mocks.bookingChangeRequestDeleteMany.mockResolvedValue({ count: 0 });
    mocks.bookingModificationDeleteMany.mockResolvedValue({ count: 1 });
    mocks.bookingEventDeleteMany.mockResolvedValue({ count: 0 });
    mocks.promoRedemptionDelete.mockResolvedValue({});
    mocks.promoRedemptionAllocationCount.mockResolvedValue(1);
    mocks.promoCodeUpdate.mockResolvedValue({});
    mocks.paymentTransactionCount.mockResolvedValue(0);
    mocks.paymentRefundCount.mockResolvedValue(0);
    mocks.refundRequestCount.mockResolvedValue(0);
    mocks.memberCreditFindMany.mockResolvedValue([]);
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
    expect(mocks.bookingChangeRequestDeleteMany).toHaveBeenCalledWith({
      where: { bookingId: { in: ["booking-1"] } },
    });
    expect(mocks.bookingModificationDeleteMany).toHaveBeenCalledWith({
      where: { bookingId: { in: ["booking-1"] } },
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

  it("soft-deletes a cancelled booking when payment attempts failed before capture", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        status: "CANCELLED",
        draftExpiresAt: null,
        payment: {
          id: "payment-1",
          status: "FAILED",
          amountCents: 4000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_failed",
          additionalPaymentIntentId: null,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroRefundCreditNoteId: null,
        },
      })
    );

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "admin-1", role: "ADMIN", ipAddress: "127.0.0.1" },
      reason: "Cancelled before payment capture",
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
    expect(mocks.paymentTransactionCount).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        OR: [
          { status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
          { refundedAmountCents: { gt: 0 } },
        ],
      },
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: {
        deletedAt: expect.any(Date),
        deletedById: "admin-1",
        deletedReason: "Cancelled before payment capture",
      },
    });
  });

  it("soft-deletes a cancelled booking when unpaid modification deltas net to zero", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        status: "CANCELLED",
        draftExpiresAt: null,
        payment: {
          id: "payment-1",
          status: "FAILED",
          amountCents: 845000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_failed",
          additionalPaymentIntentId: null,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroRefundCreditNoteId: null,
        },
        modifications: [
          {
            id: "mod-1",
            modificationType: "DATE_CHANGE",
            priceDiffCents: 169000,
            changeFeeCents: 0,
            createdAt: new Date("2026-04-20T08:55:00.000Z"),
          },
          {
            id: "mod-2",
            modificationType: "DATE_CHANGE",
            priceDiffCents: -169000,
            changeFeeCents: 0,
            createdAt: new Date("2026-04-20T09:50:00.000Z"),
          },
        ],
      })
    );

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "admin-1", role: "ADMIN", ipAddress: "127.0.0.1" },
      reason: "Booked instead via school group function",
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
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: {
        deletedAt: expect.any(Date),
        deletedById: "admin-1",
        deletedReason: "Booked instead via school group function",
      },
    });
  });

  it("blocks cancelled booking deletion when modification deltas do not net to zero", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        status: "CANCELLED",
        draftExpiresAt: null,
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

    const result = await deleteBooking({
      bookingId: "booking-1",
      actor: { memberId: "admin-1", role: "ADMIN" },
      reason: "Duplicate test booking",
    });

    expect(result.status).toBe(409);
    expect(result).toMatchObject({
      error:
        "Cancelled booking cannot be deleted because financial or Xero history exists",
      blockers: [
        {
          code: "financial_modification",
          label: "Net booking modification financial effect exists",
          count: 1,
        },
      ],
    });
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
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
    // A single un-reversed applied-credit row (net negative) still blocks.
    mocks.memberCreditFindMany.mockResolvedValue([
      { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
    ]);
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

  // ── #1547: net-zero applied-credit unblock ──────────────────────────────
  describe("#1547 delete-guard net-zero credit unblock", () => {
    function cancelledWithCreditAppliedPayment(
      paymentOverrides: Record<string, unknown> = {}
    ) {
      return makeBooking({
        status: "CANCELLED",
        draftExpiresAt: null,
        payment: {
          id: "payment-1",
          status: "FAILED",
          amountCents: 5000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          creditAppliedCents: 5000,
          stripePaymentIntentId: "pi_x",
          additionalPaymentIntentId: null,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroRefundCreditNoteId: null,
          ...paymentOverrides,
        },
      });
    }

    it("deletes a cancelled booking whose applied credit was fully reversed (net-zero, reversal-only, no Xero note)", async () => {
      mocks.bookingFindUnique.mockResolvedValue(cancelledWithCreditAppliedPayment());
      mocks.memberCreditFindMany.mockResolvedValue([
        { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
        { amountCents: 5000, type: "CANCELLATION_REFUND", xeroCreditNoteId: null },
      ]);

      const result = await deleteBooking({
        bookingId: "booking-1",
        actor: { memberId: "admin-1", role: "ADMIN", ipAddress: "127.0.0.1" },
        reason: "Fully-restored credit, no other history",
      });

      // No member_credit blocker, and the creditAppliedCents mirror is waived,
      // so the soft-delete succeeds.
      expect(result.status).toBe(200);
      expect(mocks.bookingUpdate).toHaveBeenCalledWith({
        where: { id: "booking-1" },
        data: {
          deletedAt: expect.any(Date),
          deletedById: "admin-1",
          deletedReason: "Fully-restored credit, no other history",
        },
      });
    });

    it("blocks when the applied credit was never reversed (net-negative), with a signed-net label", async () => {
      mocks.bookingFindUnique.mockResolvedValue(cancelledWithCreditAppliedPayment());
      mocks.memberCreditFindMany.mockResolvedValue([
        { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
      ]);

      const result = await deleteBooking({
        bookingId: "booking-1",
        actor: { memberId: "admin-1", role: "ADMIN" },
        reason: "Should block",
      });

      expect(result.status).toBe(409);
      expect(result).toMatchObject({
        blockers: expect.arrayContaining([
          {
            code: "member_credit",
            label: "Member credit history exists (1 row, net -$50.00)",
            count: 1,
          },
        ]),
      });
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    });

    it("blocks a coincidental net-zero that includes an ADMIN_ADJUSTMENT row (real financial history)", async () => {
      mocks.bookingFindUnique.mockResolvedValue(cancelledWithCreditAppliedPayment());
      mocks.memberCreditFindMany.mockResolvedValue([
        { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
        { amountCents: 5000, type: "ADMIN_ADJUSTMENT", xeroCreditNoteId: null },
      ]);

      const result = await deleteBooking({
        bookingId: "booking-1",
        actor: { memberId: "admin-1", role: "ADMIN" },
        reason: "Should block",
      });

      expect(result.status).toBe(409);
      expect(result).toMatchObject({
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "member_credit", count: 2 }),
        ]),
      });
    });

    it("blocks a net-zero when any credit row carries an external Xero credit note", async () => {
      mocks.bookingFindUnique.mockResolvedValue(cancelledWithCreditAppliedPayment());
      mocks.memberCreditFindMany.mockResolvedValue([
        { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
        { amountCents: 5000, type: "CANCELLATION_REFUND", xeroCreditNoteId: "cn_1" },
      ]);

      const result = await deleteBooking({
        bookingId: "booking-1",
        actor: { memberId: "admin-1", role: "ADMIN" },
        reason: "Should block",
      });

      expect(result.status).toBe(409);
      expect(result).toMatchObject({
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "member_credit" }),
        ]),
      });
    });

    it("still blocks on captured money even when the credit ledger is net-zero (waiver is creditAppliedCents-only)", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        cancelledWithCreditAppliedPayment({ status: "SUCCEEDED" })
      );
      mocks.memberCreditFindMany.mockResolvedValue([
        { amountCents: -5000, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
        { amountCents: 5000, type: "CANCELLATION_REFUND", xeroCreditNoteId: null },
      ]);

      const result = await deleteBooking({
        bookingId: "booking-1",
        actor: { memberId: "admin-1", role: "ADMIN" },
        reason: "Should block on captured money",
      });

      expect(result.status).toBe(409);
      expect(result).toMatchObject({
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "captured_payment" }),
        ]),
      });
      // The member_credit blocker is ABSENT (ledger is net-zero reversal-only).
      const blockers = "blockers" in result ? result.blockers ?? [] : [];
      expect(blockers.some((b) => b.code === "member_credit")).toBe(false);
    });
  });
});
