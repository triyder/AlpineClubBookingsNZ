import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  findFirstLink: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueMember: vi.fn(),
  findUniqueMemberSubscription: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueGroupSettlement: vi.fn(),
  findFirstPaymentTransaction: vi.fn(),
  findFirstOperation: vi.fn(),
  findManyOperations: vi.fn(),
  updateManyOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getEntranceFeeContext: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNoteForModification: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  createXeroInvoiceForGroupSettlement: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
  syncXeroMembershipCancellationContact: vi.fn(),
  isXeroConnected: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    member: {
      findUnique: mocks.findUniqueMember,
    },
    memberSubscription: {
      findUnique: mocks.findUniqueMemberSubscription,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
    },
    groupBookingSettlement: {
      findUnique: mocks.findUniqueGroupSettlement,
    },
    paymentTransaction: {
      findFirst: mocks.findFirstPaymentTransaction,
    },
    xeroObjectLink: {
      findFirst: mocks.findFirstLink,
    },
    xeroSyncOperation: {
      findFirst: mocks.findFirstOperation,
      findMany: mocks.findManyOperations,
      updateMany: mocks.updateManyOperation,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
  sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/xero-group-settlement-invoices", () => ({
  createXeroInvoiceForGroupSettlement: mocks.createXeroInvoiceForGroupSettlement,
}));

// #1208: xero-operation-outbox now imports from the source domain modules
// directly (not the @/lib/xero facade), so the doubles mock those modules.
vi.mock("@/lib/xero-booking-invoices", () => ({
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
}));

vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification:
    mocks.createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote: mocks.createXeroCreditNote,
}));

vi.mock("@/lib/xero-entrance-fee-invoices", () => ({
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
}));

vi.mock("@/lib/xero-mappings", () => ({
  buildEntranceFeeInvoiceIdempotencyKey: (
    memberId: string,
    category: string,
    amountCents: number
  ) => `member:${memberId}:entrance-fee-invoice:${category}:${amountCents}:v1`,
  getEntranceFeeContext: mocks.getEntranceFeeContext,
}));

vi.mock("@/lib/xero-modification-credit-notes", () => ({
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
}));

vi.mock("@/lib/xero-supplementary-invoices", () => ({
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
}));

vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/membership-cancellation-xero", () => ({
  createXeroMembershipCancellationCreditNote:
    mocks.createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact: mocks.syncXeroMembershipCancellationContact,
}));

import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroGroupSettlementInvoiceOperation,
  enqueueXeroEntranceFeeInvoiceOperation,
  enqueueXeroMembershipCancellationContactOperation,
  enqueueXeroMembershipCancellationCreditNoteOperation,
  enqueueXeroModificationAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
  reapStaleWaitingPaymentXeroOutboxOperations,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import { XERO_OUTBOX_QUEUE_TYPES } from "@/lib/xero-operation-outbox-payload";

describe("enqueueXeroEntranceFeeInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: null,
      },
    });
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "ADULT",
      feeMapping: {
        itemCode: "EF-ADULT",
        amountCents: 15000,
      },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_entrance_1" });
  });

  it("creates a pending primary Xero sync operation for entrance fee invoices", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero entrance fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_1",
        status: "PENDING",
        idempotencyKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
        correlationKey: "member:member_1:entrance-fee-invoice:ADULT:15000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      })
    );
  });

  it("queues entrance fee invoices with admin amount and narration overrides", async () => {
    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1", {
        createdByMemberId: "admin_1",
        amountCents: 12345,
        description: "Entrance fee waived to adjusted family rate",
      })
    ).resolves.toEqual({
      queueOperationId: "op_entrance_1",
      message: "Xero entrance fee invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "member:member_1:entrance-fee-invoice:ADULT:12345:v1",
        correlationKey: "member:member_1:entrance-fee-invoice:ADULT:12345:v1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 12345,
          description: "Entrance fee waived to adjusted family rate",
        },
      })
    );
  });

  it("skips queueing when there is no configured entrance fee", async () => {
    mocks.getEntranceFeeContext.mockResolvedValue({
      category: "CHILD",
      feeMapping: {
        itemCode: null,
        amountCents: null,
      },
    });

    await expect(
      enqueueXeroEntranceFeeInvoiceOperation("member_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No entrance fee is configured for this member category.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_1" });
  });

  it("creates a pending primary Xero sync operation for booking invoices", async () => {
    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_1",
      message: "Xero booking invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice:v1",
        correlationKey: "booking:booking_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      })
    );
  });

  it("skips queueing when the booking payment is already linked to Xero", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });

    await expect(
      enqueueXeroBookingInvoiceOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroBookingInvoiceUpdateOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_booking_update_1" });
  });

  it("creates a pending Xero sync operation for primary booking invoice updates", async () => {
    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_booking_update_1",
      message: "Xero booking invoice update queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "UPDATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        correlationKey: "booking:booking_1:invoice-update:inv_existing:2026-05-30:2026-05-31:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      })
    );
  });

  it("skips queueing when there is no original Xero invoice", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      checkIn: new Date("2026-05-30T00:00:00.000Z"),
      checkOut: new Date("2026-05-31T00:00:00.000Z"),
      payment: {
        id: "payment_1",
        xeroInvoiceId: null,
      },
    });

    await expect(
      enqueueXeroBookingInvoiceUpdateOperation("booking_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroSupplementaryInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_supplementary_1" });
  });

  it("creates a pending Xero sync operation for supplementary invoices", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message: "Xero supplementary invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        correlationKey: "booking-mod:mod_1:supplementary-invoice:2500:500:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
          recordPayment: true,
          paymentIntentId: null,
          waitForConfirmedAdditionalPayment: false,
        },
      })
    );
  });

  it("can hold supplementary invoices until additional Stripe payment succeeds", async () => {
    await expect(
      enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_supplementary_1",
      message: "Xero supplementary invoice is waiting for confirmed additional payment.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "WAITING_PAYMENT",
        requestPayload: expect.objectContaining({
          paymentIntentId: "pi_additional",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }),
      })
    );
  });

  it("releases waiting supplementary invoice operations after payment confirmation", async () => {
    mocks.findManyOperations.mockResolvedValue([{ id: "op_supplementary_1" }]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    await expect(
      releaseXeroSupplementaryInvoiceOperationsForPaymentIntent("pi_additional")
    ).resolves.toEqual({
      released: 1,
      queueOperationIds: ["op_supplementary_1"],
    });

    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["op_supplementary_1"] },
          status: "WAITING_PAYMENT",
        }),
        data: expect.objectContaining({
          status: "PENDING",
          startedAt: null,
        }),
      })
    );
  });
});

describe("enqueueXeroRefundCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_credit_note_1" });
  });

  it("creates a pending primary Xero sync operation for non-Stripe refund credit notes", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:refund-credit-note:5000:v1",
        correlationKey: "payment:payment_1:refund-credit-note:5000:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 5000,
          watermarkCents: 5000,
        },
      })
    );
    // Non-Stripe payments never consult the cumulative refund watermark.
    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
  });

  it("queues the uncovered delta with a v2 watermark key for a second Stripe refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_credit_note_1",
      message: "Xero refund credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "payment:payment_1:refund-credit-note:8000:v2",
        correlationKey: "payment:payment_1:refund-credit-note:8000:v2",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      })
    );
  });

  it("skips a replayed Stripe delta once the notes already cover the refund", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 8000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(8000);

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 3000)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Refund credit notes already cover this payment's refunded amount.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("gives two equal Stripe deltas distinct watermark correlation keys", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: null,
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "STRIPE",
      refundedAmountCents: 10000,
      xeroRefundCreditNoteId: "cn_1",
    });
    mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(5000);
    await enqueueXeroRefundCreditNoteOperation("payment_1", 5000);

    const firstKey = mocks.startXeroSyncOperation.mock.calls[0][0].correlationKey;
    const secondKey = mocks.startXeroSyncOperation.mock.calls[1][0].correlationKey;
    expect(firstKey).toBe("payment:payment_1:refund-credit-note:5000:v2");
    expect(secondKey).toBe("payment:payment_1:refund-credit-note:10000:v2");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps the legacy single-note skip for non-Stripe payments already linked", async () => {
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
      source: "INTERNET_BANKING",
      refundedAmountCents: 5000,
      xeroRefundCreditNoteId: "cn_existing",
    });
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({
      xeroObjectId: "cn_existing",
      xeroObjectNumber: "CN-1",
      source: "payment",
    });

    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 5000)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    });

    expect(mocks.sumCoveredRefundCreditNoteCents).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("skips queueing when the webhook delta is zero", async () => {
    await expect(
      enqueueXeroRefundCreditNoteOperation("payment_1", 0)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    });

    expect(mocks.findCanonicalPaymentRefundCreditNote).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniquePayment.mockResolvedValue({
      id: "payment_1",
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_account_credit_1" });
  });

  it("creates a pending primary Xero sync operation for account-credit notes", async () => {
    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        status: "PENDING",
        idempotencyKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        correlationKey: "payment:payment_1:unapplied-credit-note:4200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      })
    );
  });

  it("skips queueing when the account-credit note is already linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ id: "link_account_credit_1" });

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200)
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("reads and enqueues through the supplied transaction store, leaving the global prisma client untouched", async () => {
    // Fresh store fns distinct from the global prisma mock so the assertions
    // below actually prove the store — not the global client — was used.
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi.fn().mockResolvedValue(null);
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "op_account_credit_1",
      message: "Xero account-credit note queued for background processing.",
    });

    // Every read went through the store.
    expect(storePaymentFindUnique).toHaveBeenCalledTimes(1);
    expect(storeLinkFindFirst).toHaveBeenCalledTimes(1);
    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    // The global prisma client was never touched.
    expect(mocks.findUniquePayment).not.toHaveBeenCalled();
    expect(mocks.findFirstLink).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
    // The store is threaded into the operation writer so the row commits in-tx.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        store,
      })
    );
  });

  it("dedups on an existing queued operation read through the supplied store", async () => {
    const storePaymentFindUnique = vi.fn().mockResolvedValue({ id: "payment_1" });
    const storeLinkFindFirst = vi.fn().mockResolvedValue(null);
    const storeOperationFindFirst = vi
      .fn()
      .mockResolvedValue({ id: "existing_queued_op" });
    const store = {
      payment: { findUnique: storePaymentFindUnique },
      xeroObjectLink: { findFirst: storeLinkFindFirst },
      xeroSyncOperation: { findFirst: storeOperationFindFirst },
    } as unknown as Prisma.TransactionClient;

    await expect(
      enqueueXeroAccountCreditNoteOperation("payment_1", 4200, { store })
    ).resolves.toEqual({
      queueOperationId: "existing_queued_op",
      message: "Xero account-credit note is already queued for background processing.",
    });

    expect(storeOperationFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.findFirstOperation).not.toHaveBeenCalled();
  });
});

describe("enqueueXeroModificationCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        xeroInvoiceId: "inv_existing",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_credit_note_1" });
  });

  it("creates a pending Xero sync operation for modification credit notes", async () => {
    await expect(
      enqueueXeroModificationCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_credit_note_1",
      message: "Xero modification credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        correlationKey: "booking-mod:mod_1:mod-credit-note:3200:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      })
    );
  });
});

describe("enqueueXeroModificationAccountCreditNoteOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueBooking.mockResolvedValue({
      id: "booking_1",
      payment: {
        id: "payment_1",
      },
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_mod_account_credit_1" });
  });

  it("creates a pending Xero sync operation for modification account-credit notes", async () => {
    await expect(
      enqueueXeroModificationAccountCreditNoteOperation(
        {
          bookingId: "booking_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_mod_account_credit_1",
      message: "Xero modification account-credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        correlationKey: "booking-mod:mod_1:mod-account-credit-note:3750:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "booking_1",
          paymentId: "payment_1",
          refundAmountCents: 3750,
          bookingModificationId: "mod_1",
        },
      })
    );
  });
});

describe("enqueueXeroCreditNoteAllocationOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_allocation_1" });
  });

  it("creates a pending Xero sync operation for credit-note allocations", async () => {
    await expect(
      enqueueXeroCreditNoteAllocationOperation(
        {
          localModel: "BookingModification",
          localId: "mod_1",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
        {
          createdByMemberId: "admin_1",
        }
      )
    ).resolves.toEqual({
      queueOperationId: "op_allocation_1",
      message: "Xero credit-note allocation queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        localModel: "BookingModification",
        localId: "mod_1",
        status: "PENDING",
        idempotencyKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        correlationKey:
          "credit-note:cn_1:invoice:inv_1:allocation:3200:MODIFICATION_CREDIT_NOTE_ALLOCATION:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      })
    );
  });
});

describe("membership cancellation Xero enqueue operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_cancel_1" });
  });

  it("queues credit notes for unpaid current-season membership subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "UNPAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation credit note queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_1",
        status: "PENDING",
        idempotencyKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        correlationKey:
          "member-subscription:sub_1:membership-cancellation-credit:participant_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });

  it("does not queue membership cancellation credit notes for paid subscriptions", async () => {
    mocks.findUniqueMemberSubscription.mockResolvedValue({
      id: "sub_1",
      status: "PAID",
      xeroInvoiceId: "inv_sub_1",
    });

    await expect(
      enqueueXeroMembershipCancellationCreditNoteOperation({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
      })
    ).resolves.toEqual({
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    });

    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("queues contact cleanup when the cancelling member has a Xero contact", async () => {
    mocks.findUniqueMember.mockResolvedValue({
      id: "member_1",
      xeroContactId: "contact_1",
    });

    await expect(
      enqueueXeroMembershipCancellationContactOperation(
        {
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
        { createdByMemberId: "admin_1" }
      )
    ).resolves.toEqual({
      queueOperationId: "op_cancel_1",
      message: "Xero membership cancellation contact cleanup queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "MembershipCancellationRequestParticipant",
        localId: "participant_1",
        status: "PENDING",
        idempotencyKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        correlationKey:
          "membership-cancellation:participant_1:contact:member_1:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );
  });
});

describe("enqueueXeroGroupSettlementInvoiceOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstLink.mockResolvedValue(null);
    mocks.findUniqueGroupSettlement.mockResolvedValue({
      id: "settle_1",
      xeroInvoiceId: null,
    });
    mocks.findFirstOperation.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_settle_1" });
  });

  it("creates a pending invoice sync operation against the settlement", async () => {
    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1", {
        createdByMemberId: "admin_1",
      })
    ).resolves.toEqual({
      queueOperationId: "op_settle_1",
      message: "Xero settlement invoice queued for background processing.",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        status: "PENDING",
        idempotencyKey: "group-settlement:settle_1:invoice:v1",
        correlationKey: "group-settlement:settle_1:invoice:v1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      })
    );
  });

  it("skips queueing when the settlement already carries an invoice", async () => {
    mocks.findUniqueGroupSettlement.mockResolvedValue({
      id: "settle_1",
      xeroInvoiceId: "xinv_existing",
    });

    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1")
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });
});

describe("processQueuedXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  });

  it("scans the pending outbox by the indexed queueType column, not a requestPayload JSON predicate (#1272)", async () => {
    mocks.findManyOperations.mockResolvedValue([]);

    await processQueuedXeroOutboxOperations({ limit: 7 });

    expect(mocks.findManyOperations).toHaveBeenCalledTimes(1);
    const args = mocks.findManyOperations.mock.calls[0][0];
    // The scan now filters on the denormalized `queueType` column via the
    // single-source-of-truth list, keeping status/direction/order/limit intact.
    expect(args.where).toEqual({
      status: "PENDING",
      direction: "OUTBOUND",
      queueType: { in: [...XERO_OUTBOX_QUEUE_TYPES] },
    });
    expect(args.where.queueType.in).toHaveLength(12);
    // The legacy 12-branch `requestPayload->>'queueType'` OR predicate is gone.
    expect(args.where.OR).toBeUndefined();
    expect(JSON.stringify(args.where)).not.toContain("requestPayload");
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(7);
  });

  it("claims and processes queued entrance fee operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
          category: "ADULT",
          itemCode: "EF-ADULT",
          feeAmountCents: 15000,
        },
      },
    ]);
    mocks.createXeroEntranceFeeInvoice.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("member_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_entrance_1",
      precomputedEntranceFee: {
        category: "ADULT",
        feeMapping: {
          itemCode: "EF-ADULT",
          amountCents: 15000,
        },
      },
    });
  });

  it("claims and processes queued booking invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE",
          bookingId: "booking_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForBooking.mockResolvedValue("inv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_1",
    });
  });

  it("claims and processes queued group settlement invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_settle_1",
        localId: "settle_1",
        localModel: "GroupBookingSettlement",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE",
          settlementId: "settle_1",
        },
      },
    ]);
    mocks.createXeroInvoiceForGroupSettlement.mockResolvedValue("xinv_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroInvoiceForGroupSettlement).toHaveBeenCalledWith(
      "settle_1",
      {
        createdByMemberId: "admin_1",
        syncOperationId: "op_settle_1",
      }
    );
  });

  it("claims and processes queued booking invoice update operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_booking_update_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "BOOKING_INVOICE_UPDATE",
          bookingId: "booking_1",
          xeroInvoiceId: "inv_existing",
        },
      },
    ]);
    mocks.updateXeroBookingInvoiceForBooking.mockResolvedValue("inv_existing");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.updateXeroBookingInvoiceForBooking).toHaveBeenCalledWith("booking_1", {
      createdByMemberId: "admin_1",
      syncOperationId: "op_booking_update_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "INVOICE",
          operationType: "UPDATE",
        }),
      })
    );
  });

  it("claims and processes queued refund credit note operations, forwarding the watermark", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_credit_note_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
    ]);
    mocks.createXeroCreditNote.mockResolvedValue("cn_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("payment_1", 3000, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_credit_note_1",
      watermarkCents: 8000,
    });
  });

  it("claims and processes queued account-credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_account_credit_1",
        localId: "payment_1",
        localModel: "Payment",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4200,
        },
      },
    ]);
    mocks.createUnappliedXeroCreditNote.mockResolvedValue("cn_account_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("payment_1", 4200, {
      createdByMemberId: "admin_1",
      syncOperationId: "op_account_credit_1",
    });
  });

  it("claims and processes queued supplementary invoice operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_supplementary_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroSupplementaryInvoice.mockResolvedValue("inv_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "booking_1",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_1",
      recordPayment: true,
      createdByMemberId: "admin_1",
      syncOperationId: "op_supplementary_1",
    });
  });

  it("claims and processes queued modification credit note operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_mod_credit_note_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 3200,
          bookingModificationId: "mod_1",
        },
      },
    ]);
    mocks.createXeroCreditNoteForModification.mockResolvedValue("cn_2");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "booking_1",
      refundAmountCents: 3200,
      bookingModificationId: "mod_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_mod_credit_note_1",
    });
  });

  it("claims and processes queued credit-note allocation operations", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_allocation_1",
        localId: "mod_1",
        localModel: "BookingModification",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_1",
          invoiceId: "inv_1",
          amountCents: 3200,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
    ]);
    mocks.allocateCreditNoteToInvoice.mockResolvedValue(undefined);

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_1",
      "inv_1",
      3200,
      {
        localModel: "BookingModification",
        localId: "mod_1",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        createdByMemberId: "admin_1",
        syncOperationId: "op_allocation_1",
      }
    );
  });

  it("claims and processes queued membership cancellation credit notes", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_credit_1",
        localId: "sub_1",
        localModel: "MemberSubscription",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.createXeroMembershipCancellationCreditNote.mockResolvedValue("cn_sub_1");

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_credit_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: { in: ["MemberSubscription"] },
        }),
      })
    );
  });

  it("claims and processes queued membership cancellation contact cleanup", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_membership_cancel_contact_1",
        localId: "participant_1",
        localModel: "MembershipCancellationRequestParticipant",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
        },
      },
    ]);
    mocks.syncXeroMembershipCancellationContact.mockResolvedValue({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: ["cancelled_group"],
      removedGroupIds: ["adult_group"],
      archived: true,
      skippedReason: null,
    });

    await expect(processQueuedXeroOutboxOperations({ limit: 5 })).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.syncXeroMembershipCancellationContact).toHaveBeenCalledWith({
      memberId: "member_1",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_membership_cancel_contact_1",
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "CONTACT",
          operationType: "UPDATE",
          localModel: { in: ["MembershipCancellationRequestParticipant"] },
        }),
      })
    );
  });

  it("fails malformed queued payloads", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_entrance_1",
        localModel: "Member",
        localId: "member_1",
        createdByMemberId: "admin_1",
        requestPayload: {
          queueType: "ENTRANCE_FEE_INVOICE",
        },
      },
    ]);

    await expect(processQueuedXeroOutboxOperations()).resolves.toEqual({
      found: 1,
      processed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    expect(mocks.createXeroEntranceFeeInvoice).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_entrance_1",
      expect.objectContaining({
        message: "Queued Xero outbox payload is incomplete.",
      })
    );
  });
});

describe("reapStaleWaitingPaymentXeroOutboxOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);
    mocks.updateManyOperation.mockResolvedValue({ count: 0 });
  });

  it("reaps WAITING_PAYMENT operations whose linked PaymentTransaction is FAILED", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_1",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_failed_abc" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue({ id: "txn-failed" });
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstPaymentTransaction).toHaveBeenCalledWith({
      where: {
        source: "STRIPE",
        stripePaymentIntentId: "pi_failed_abc",
        status: "FAILED",
      },
      select: { id: true },
    });
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: { in: ["op_waiting_1"] },
        status: "WAITING_PAYMENT",
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
      }),
    });
    expect(result).toEqual({
      reaped: 1,
      queueOperationIds: ["op_waiting_1"],
    });
  });

  it("reaps WAITING_PAYMENT operations older than the staleness threshold", async () => {
    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_old",
        createdAt: sixteenDaysAgo,
        requestPayload: { paymentIntentId: "pi_still_pending" },
      },
    ]);
    mocks.updateManyOperation.mockResolvedValue({ count: 1 });

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(mocks.findFirstPaymentTransaction).not.toHaveBeenCalled();
    expect(mocks.updateManyOperation).toHaveBeenCalledWith({
      where: {
        id: { in: ["op_waiting_old"] },
        status: "WAITING_PAYMENT",
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
      }),
    });
    expect(result.reaped).toBe(1);
  });

  it("leaves recent WAITING_PAYMENT operations with active payments alone", async () => {
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_waiting_fresh",
        createdAt: new Date(),
        requestPayload: { paymentIntentId: "pi_still_active" },
      },
    ]);
    mocks.findFirstPaymentTransaction.mockResolvedValue(null);

    const result = await reapStaleWaitingPaymentXeroOutboxOperations();

    expect(result.reaped).toBe(0);
    expect(mocks.updateManyOperation).not.toHaveBeenCalled();
  });
});
