import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueMember: vi.fn(),
  updatePayment: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findUniqueBooking: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  buildXeroContactUpdatePayload: vi.fn(),
  shouldRepairXeroContactNameOrder: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  updateXeroContact: vi.fn(),
  createXeroInvoiceForBooking: vi.fn(),
  updateXeroBookingInvoiceForBooking: vi.fn(),
  createXeroEntranceFeeInvoice: vi.fn(),
  createXeroSupplementaryInvoice: vi.fn(),
  createXeroPaymentForInvoice: vi.fn(),
  createXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNote: vi.fn(),
  createUnappliedXeroCreditNoteForModification: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
  createXeroRefundPaymentForInvoice: vi.fn(),
  allocateCreditNoteToInvoice: vi.fn(),
  checkMembershipStatus: vi.fn(),
  createXeroMembershipCancellationCreditNote: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
      update: mocks.updatePayment,
    },
    member: {
      findUnique: mocks.findUniqueMember,
    },
    bookingModification: {
      findUnique: mocks.findUniqueBookingModification,
    },
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
  },
}));

vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: mocks.buildXeroContactUpdatePayload,
  shouldRepairXeroContactNameOrder: mocks.shouldRepairXeroContactNameOrder,
}));

vi.mock("@/lib/xero", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  updateXeroContact: mocks.updateXeroContact,
  createXeroInvoiceForBooking: mocks.createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking: mocks.updateXeroBookingInvoiceForBooking,
  createXeroEntranceFeeInvoice: mocks.createXeroEntranceFeeInvoice,
  createXeroSupplementaryInvoice: mocks.createXeroSupplementaryInvoice,
  createXeroPaymentForInvoice: mocks.createXeroPaymentForInvoice,
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: mocks.createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification:
    mocks.createUnappliedXeroCreditNoteForModification,
  createXeroCreditNoteForModification: mocks.createXeroCreditNoteForModification,
  createXeroRefundPaymentForInvoice: mocks.createXeroRefundPaymentForInvoice,
  allocateCreditNoteToInvoice: mocks.allocateCreditNoteToInvoice,
  checkMembershipStatus: mocks.checkMembershipStatus,
}));

vi.mock("@/lib/membership-cancellation-xero", () => ({
  createXeroMembershipCancellationCreditNote: mocks.createXeroMembershipCancellationCreditNote,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();

  return {
    ...actual,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  };
});

import {
  getXeroOperationRetryMeta,
  retryXeroSyncOperation,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";
import { CLUB_NAME } from "@/config/club-identity";

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_123",
    status: "FAILED",
    replayable: true,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_123",
    requestPayload: null,
    responsePayload: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    ...overrides,
  };
}

describe("getXeroOperationRetryMeta", () => {
  it("marks failed payment invoice operations as retryable", () => {
    expect(getXeroOperationRetryMeta(makeOperation())).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks failed payment invoice update operations as retryable", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          operationType: "UPDATE",
        })
      )
    ).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks repairable partial invoice operations as supported", () => {
    expect(
      getXeroOperationRetryMeta(
        makeOperation({
          status: "PARTIAL",
          xeroObjectId: "inv_123",
          responsePayload: {
            invoice: {
              invoices: [{ total: 45.67 }],
            },
          },
        })
      )
    ).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("blocks partial repairs when the stored invoice state is incomplete", () => {
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).supported).toBe(false);
    expect(getXeroOperationRetryMeta(makeOperation({ status: "PARTIAL" })).reason).toContain(
      "incomplete"
    );
  });

  it("allows member contact updates to be rebuilt from the current member record", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: null,
      })
    );

    expect(result).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("marks failed membership cancellation credit note operations as retryable", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: {
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );

    expect(result).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("rejects membership cancellation credit note retries with an incomplete stored payload", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: { requestId: "request_1" },
      })
    );

    expect(result).toEqual({
      supported: false,
      reason: "This credit note retry path is not supported by the current replay helper.",
    });
  });

  it("requires a complete stored payload for non-member contact updates", () => {
    const result = getXeroOperationRetryMeta(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "ExternalContact",
        localId: "external_123",
        requestPayload: { contacts: [{}] },
      })
    );

    expect(result).toEqual({
      supported: false,
      reason: "Stored contact update payload is incomplete.",
    });
  });
});

describe("retryXeroSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueMember.mockResolvedValue(null);
    mocks.shouldRepairXeroContactNameOrder.mockResolvedValue(false);
    mocks.buildXeroContactUpdatePayload.mockImplementation((member) => ({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      dateOfBirth: member.dateOfBirth,
      phoneCountryCode: member.phoneCountryCode,
      phoneAreaCode: member.phoneAreaCode,
      phoneNumber: member.phoneNumber,
      streetAddressLine1: member.streetAddressLine1,
      streetAddressLine2: member.streetAddressLine2,
      streetCity: member.streetCity,
      streetRegion: member.streetRegion,
      streetPostalCode: member.streetPostalCode,
      streetCountry: member.streetCountry,
      postalAddressLine1: member.postalAddressLine1,
      postalAddressLine2: member.postalAddressLine2,
      postalCity: member.postalCity,
      postalRegion: member.postalRegion,
      postalPostalCode: member.postalPostalCode,
      postalCountry: member.postalCountry,
    }));
  });

  it("replays a queued-shape refund credit note op in delta mode (#1354)", async () => {
    // An op that failed BEFORE its handler overwrote requestPayload still
    // carries the enqueue-time queued shape. Pre-#1354 the parser returned
    // null ("Stored credit note payload is incomplete.") — a permanent
    // dead-end after an operator stale-reset.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    // Delta mode re-entered: the watermark is threaded through (the value is
    // advisory — createXeroCreditNote recomputes coverage at execution time).
    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 8000,
    });
  });

  it("re-enters delta mode via the queueType column when the payload was overwritten (#1354)", async () => {
    // Overwritten (Xero-request-shaped) payload with no watermark: the
    // denormalized enqueue-time queueType still marks it as a per-delta op.
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "REFUND_CREDIT_NOTE",
        requestPayload: {
          creditNotes: [{ lineItems: [{ unitAmount: 30 }] }],
          allocation: { invoiceId: "inv_1", amount: 30 },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero refund credit note creation." });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_9", 3000, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
      watermarkCents: 0,
    });
  });

  it("replays a queued-shape account-credit note op (#1354)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        localId: "pay_9",
        queueType: "ACCOUNT_CREDIT_NOTE",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 4500,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({ message: "Retried Xero account-credit note creation." });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_9", 4500, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays booking invoice creation through the booking payment relationship", async () => {
    mocks.findUniqueOperation.mockResolvedValue(makeOperation());
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice creation.",
    });

    expect(mocks.createXeroInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays booking invoice updates through the booking payment relationship", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        operationType: "UPDATE",
      })
    );
    mocks.findUniquePayment.mockResolvedValue({ bookingId: "book_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero booking invoice update.",
    });

    expect(mocks.updateXeroBookingInvoiceForBooking).toHaveBeenCalledWith("book_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays entrance-fee invoice creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        localModel: "Member",
        localId: "mem_123",
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero entrance fee invoice creation.",
    });

    expect(mocks.createXeroEntranceFeeInvoice).toHaveBeenCalledWith("mem_123", {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays contact updates using the stored request payload", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_1",
              firstName: "Jane",
              lastName: "Doe",
              emailAddress: "jane@example.com",
              companyNumber: "02/03/1990",
              phones: [
                {
                  phoneCountryCode: "64",
                  phoneAreaCode: "21",
                  phoneNumber: "1234567",
                },
              ],
              addresses: [
                {
                  addressType: "STREET",
                  addressLine1: "1 Test Street",
                  city: "Auckland",
                  region: "Auckland",
                  postalCode: "1010",
                  country: "NZ",
                },
                {
                  addressType: "POBOX",
                  addressLine1: "PO Box 99",
                  city: "Auckland",
                  region: "Auckland",
                  postalCode: "1140",
                  country: "NZ",
                },
              ],
            },
          ],
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.updateXeroContact).toHaveBeenCalledWith(
      "xero_contact_1",
      expect.objectContaining({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "1234567",
        streetAddressLine1: "1 Test Street",
        postalAddressLine1: "PO Box 99",
        dateOfBirth: new Date(Date.UTC(1990, 2, 2)),
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "mem_123",
        createdByMemberId: "admin_1",
        preserveXeroName: false,
      })
    );
  });

  it("rebuilds member contact updates from the current member when the stored payload is redacted", async () => {
    const currentMember = {
      xeroContactId: "xero_contact_current",
      firstName: "Janet",
      lastName: "Doe",
      email: "janet@example.com",
      dateOfBirth: new Date(Date.UTC(1991, 4, 6)),
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "7654321",
      streetAddressLine1: "2 Current Street",
      streetAddressLine2: null,
      streetCity: "Rotorua",
      streetRegion: "Bay of Plenty",
      streetPostalCode: "3010",
      streetCountry: "NZ",
      postalAddressLine1: "PO Box 100",
      postalAddressLine2: null,
      postalCity: "Rotorua",
      postalRegion: "Bay of Plenty",
      postalPostalCode: "3040",
      postalCountry: "NZ",
    };
    mocks.findUniqueMember.mockResolvedValue(currentMember);
    mocks.shouldRepairXeroContactNameOrder.mockResolvedValue(true);
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_old",
              firstName: "Jane",
              lastName: "Doe",
              emailAddress: "[REDACTED]",
              phones: [{ phoneNumber: "[REDACTED]" }],
            },
          ],
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.updateXeroContact).toHaveBeenCalledWith(
      "xero_contact_current",
      expect.objectContaining({
        firstName: "Janet",
        lastName: "Doe",
        email: "janet@example.com",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "7654321",
        streetAddressLine1: "2 Current Street",
        postalAddressLine1: "PO Box 100",
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "mem_123",
        createdByMemberId: "admin_1",
        preserveXeroName: false,
      })
    );
  });

  it("replays contact updates that intentionally preserve the Xero contact name", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Member",
        localId: "mem_123",
        requestPayload: {
          contacts: [
            {
              contactID: "xero_contact_1",
              emailAddress: "jane@example.com",
              phones: [
                {
                  phoneCountryCode: "64",
                  phoneAreaCode: "21",
                  phoneNumber: "7654321",
                },
              ],
            },
          ],
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.updateXeroContact).toHaveBeenCalledWith(
      "xero_contact_1",
      expect.objectContaining({
        email: "jane@example.com",
        phoneCountryCode: "64",
        phoneAreaCode: "21",
        phoneNumber: "7654321",
      }),
      expect.objectContaining({
        localModel: "Member",
        localId: "mem_123",
        createdByMemberId: "admin_1",
        preserveXeroName: true,
      })
    );
  });

  it("replays payment credit note creation using the stored refund amount", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_123",
            amount: 12.34,
          },
        },
      })
    );

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNote).toHaveBeenCalledWith("pay_123", 1234, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays unapplied account-credit creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_123",
        requestPayload: {
          creditNotes: [
            {
              lineItems: [{ unitAmount: 23.45 }],
            },
          ],
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNote).toHaveBeenCalledWith("pay_123", 2345, {
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays supplementary invoice creation for booking modifications", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "book_123",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_123",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  // #1356: a surviving queued payload wins over the modification record — the
  // Xero idempotency key embeds the amounts, so replaying the stored values
  // keeps the retry deduplicable against the original attempt (a pre-#1356
  // clamped operation must NOT re-bill under a fresh signed key).
  it("replays the STORED payload amounts over the record for key stability (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_legacy",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "book_123",
          priceDiffCents: 0,
          changeFeeCents: 1000,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        priceDiffCents: 0,
        changeFeeCents: 1000,
      })
    );
  });

  it("refuses to rebuild a supplementary invoice whose signed net is not billable (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_net_negative",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -1500,
      changeFeeCents: 1000,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow("no longer has a billable Xero delta");
    expect(mocks.createXeroSupplementaryInvoice).not.toHaveBeenCalled();
  });

  // #1356 (F16): the rebuilt supplementary invoice must keep the SIGNED price
  // reduction so its lines sum to the net, matching the primary queue path.
  it("replays mixed-sign supplementary invoices with the signed reduction (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_mixed",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroSupplementaryInvoice).toHaveBeenCalledWith({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
      bookingModificationId: "mod_mixed",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("replays modification credit note creation with contact relink enabled", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -2500,
      changeFeeCents: 0,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification credit note creation.",
    });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "book_123",
      refundAmountCents: 2500,
      bookingModificationId: "mod_123",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  // #1356: the enqueued policy-limited refund amount wins over any rebuild —
  // the modification row does not record the settlement cap, and the amount
  // is embedded in the Xero idempotency key.
  it("replays the STORED policy-limited credit-note amount over the record (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_policy",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "book_123",
          refundAmountCents: 2500,
          bookingModificationId: "mod_policy",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -10000,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2500 })
    );
  });

  it("recovers the stored amount from an executor-overwritten credit-note payload (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_overwritten",
        requestPayload: {
          creditNotes: [{ lineItems: [{ quantity: 1, unitAmount: 25 }] }],
          invoiceId: "inv_orig",
          refundAmountCents: 2500,
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -10000,
      changeFeeCents: 0,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmountCents: 2500 })
    );
  });

  // #1356: an account-credit settlement rebuilds as an UNAPPLIED credit note —
  // the member already holds the matching spendable credit locally, so an
  // invoice-applied note would double-count the reduction.
  it("replays account-credit modification ops as unapplied credit notes (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_account",
        requestPayload: {
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          bookingId: "book_123",
          paymentId: "pay_123",
          refundAmountCents: 3750,
          bookingModificationId: "mod_account",
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -5000,
      changeFeeCents: 0,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero modification account-credit note creation.",
    });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith({
      paymentId: "pay_123",
      refundAmountCents: 3750,
      bookingModificationId: "mod_account",
      createdByMemberId: "admin_1",
    });
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
  });

  it("discriminates account-credit ops via the queueType column when the payload was overwritten (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_account_overwritten",
        queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
        requestPayload: {
          creditNotes: [{ lineItems: [{ quantity: 1, unitAmount: 37.5 }] }],
        },
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -3750,
      changeFeeCents: 0,
    });
    mocks.findUniqueBooking.mockResolvedValue({
      payment: { id: "pay_123" },
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createUnappliedXeroCreditNoteForModification).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_123",
        refundAmountCents: 3750,
      })
    );
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
  });

  // #1356 (F16): the rebuilt modification credit note refunds the NET of the
  // signed components — |priceDiff| alone would over-credit by the fee on a
  // mixed-sign reduction-plus-fee edit.
  it("replays mixed-sign modification credit notes for the net, not |priceDiff| (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_mixed_net",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -1000,
      changeFeeCents: 500,
    });

    await retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" });

    expect(mocks.createXeroCreditNoteForModification).toHaveBeenCalledWith({
      bookingId: "book_123",
      refundAmountCents: 500,
      bookingModificationId: "mod_mixed_net",
      createdByMemberId: "admin_1",
      repairExistingLink: true,
    });
  });

  it("refuses to rebuild a modification credit note when the signed net is not a reduction (#1356)", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_net_positive",
      })
    );
    mocks.findUniqueBookingModification.mockResolvedValue({
      bookingId: "book_123",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).rejects.toThrow("no longer has a refundable Xero delta");
    expect(mocks.createXeroCreditNoteForModification).not.toHaveBeenCalled();
  });

  it("repairs partial booking invoice payment recording", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_123",
        responsePayload: {
          invoice: {
            invoices: [{ total: 45.67 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero booking invoice payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith({
      localModel: "Payment",
      localId: "pay_123",
      invoiceId: "inv_123",
      amountCents: 4567,
      idempotencyKey: "payment:pay_123:invoice-payment:v1",
      reference: `${CLUB_NAME} invoice payment pay_123`,
      role: "INVOICE_PAYMENT",
      createdByMemberId: "admin_1",
      metadata: {
        invoiceId: "inv_123",
        amountCents: 4567,
      },
    });
  });

  it("repairs partial supplementary invoice payment recording", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        localModel: "BookingModification",
        localId: "mod_123",
        xeroObjectId: "inv_sup_123",
        responsePayload: {
          invoice: {
            invoices: [{ total: 30 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero supplementary invoice payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).toHaveBeenCalledWith({
      localModel: "BookingModification",
      localId: "mod_123",
      invoiceId: "inv_sup_123",
      amountCents: 3000,
      idempotencyKey: "booking-mod:mod_123:supplementary-payment:3000:v1",
      reference: `${CLUB_NAME} supplementary payment mod_123`,
      role: "SUPPLEMENTARY_INVOICE_PAYMENT",
      createdByMemberId: "admin_1",
      metadata: {
        invoiceId: "inv_sup_123",
        amountCents: 3000,
      },
    });
  });

  it("marks zero-total booking invoice partials as repaired without creating a payment", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        xeroObjectId: "inv_zero",
        responsePayload: {
          invoice: {
            invoices: [{ total: 0 }],
          },
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Marked zero-total Xero booking invoice as repaired without payment recording.",
    });

    expect(mocks.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_zero",
        responsePayload: expect.objectContaining({
          payment: null,
          paymentError: null,
          paymentSkipped: true,
          paymentSkipReason: "Zero-total invoice does not require Xero payment recording.",
        }),
      })
    );
  });

  it("repairs partial refund credit note follow-up actions", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_123",
            amount: 12.34,
          },
        },
        responsePayload: {
          allocation: {
            allocations: [{ amount: 12.34 }],
          },
        },
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_123" },
    });
    expect(mocks.createXeroRefundPaymentForInvoice).toHaveBeenCalledWith({
      paymentId: "pay_123",
      invoiceId: "inv_123",
      creditNoteId: "cn_123",
      refundAmountCents: 1234,
      createdByMemberId: "admin_1",
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_123",
        responsePayload: expect.objectContaining({
          allocation: null,
          allocationSkipped: true,
          allocationSkipReason:
            "Refund credit notes are settled via a credit-note payment instead of invoice allocation.",
          refundPaymentError: null,
        }),
      })
    );
  });

  it("repairs failed refund credit note creates from the existing Xero credit note", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "FAILED",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        xeroObjectId: "cn_legacy_123",
        xeroObjectNumber: "CN-123",
        requestPayload: {
          allocation: {
            invoiceId: "inv_legacy_123",
            amount: 0.1,
          },
        },
        responsePayload: "{\"response\":{\"statusCode\":400}}",
      })
    );
    mocks.updatePayment.mockResolvedValue({ id: "pay_123" });

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero refund credit note follow-up actions.",
    });

    expect(mocks.createXeroCreditNote).not.toHaveBeenCalled();
    expect(mocks.allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(mocks.updatePayment).toHaveBeenCalledWith({
      where: { id: "pay_123" },
      data: { xeroRefundCreditNoteId: "cn_legacy_123" },
    });
    expect(mocks.createXeroRefundPaymentForInvoice).toHaveBeenCalledWith({
      paymentId: "pay_123",
      invoiceId: "inv_legacy_123",
      creditNoteId: "cn_legacy_123",
      refundAmountCents: 10,
      createdByMemberId: "admin_1",
    });
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_123",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_legacy_123",
        xeroObjectNumber: "CN-123",
      })
    );
  });

  it("repairs partial modification credit note allocations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod_123",
        xeroObjectId: "cn_123",
        requestPayload: {
          invoiceId: "inv_123",
          refundAmountCents: 2500,
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Repaired Xero modification credit note allocation.",
    });

    expect(mocks.allocateCreditNoteToInvoice).toHaveBeenCalledWith(
      "cn_123",
      "inv_123",
      2500,
      {
        localModel: "BookingModification",
        localId: "mod_123",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        createdByMemberId: "admin_1",
      }
    );
  });

  it("replays membership cancellation credit note creation using the stored request payload", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "MemberSubscription",
        localId: "sub_123",
        requestPayload: {
          requestId: "request_1",
          participantId: "participant_1",
        },
      })
    );

    await expect(
      retryXeroSyncOperation("op_123", { createdByMemberId: "admin_1" })
    ).resolves.toEqual({
      message: "Retried Xero membership cancellation credit note creation.",
    });

    expect(mocks.createXeroMembershipCancellationCreditNote).toHaveBeenCalledWith({
      subscriptionId: "sub_123",
      requestId: "request_1",
      participantId: "participant_1",
      createdByMemberId: "admin_1",
      syncOperationId: "op_123",
    });
  });

  it("throws a typed retry error for unsupported operations", async () => {
    mocks.findUniqueOperation.mockResolvedValue(
      makeOperation({
        status: "PARTIAL",
      })
    );

    await expect(retryXeroSyncOperation("op_123")).rejects.toMatchObject({
      name: "XeroOperationRetryError",
      status: 400,
    } satisfies Partial<XeroOperationRetryError>);
  });
});
