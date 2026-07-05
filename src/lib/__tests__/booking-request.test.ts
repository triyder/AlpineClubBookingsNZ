import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingRequestStatus, BookingStatus, PaymentStatus } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    bookingRequestSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    member: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    bookingGuest: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      create: vi.fn(),
    },
    paymentLink: {
      create: vi.fn(),
    },
    season: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminBookingRequestPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestDeclinedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
}));

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(2),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-placeholder"),
}));

// Keep the real BookingMemberNightConflictError so `instanceof` checks and the
// error constructor stay usable; only the assertion is a controllable spy.
vi.mock("@/lib/booking-member-night-conflicts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-member-night-conflicts")>();
  return {
    ...actual,
    assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  };
});

import { prisma } from "@/lib/prisma";
import {
  sendBookingRequestVerificationEmail,
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
} from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import { hashActionToken } from "@/lib/action-tokens";
import {
  approveBookingRequest,
  assertMappableOwnerContact,
  BookingRequestError,
  createBookingRequest,
  declineBookingRequest,
  getBookingRequestSettings,
  priceBookingRequest,
  purgeExpiredBookingRequests,
  resolveRequestBookingHoldUntil,
  splitPriceAcrossGuests,
  updateBookingRequestSettings,
  verifyBookingRequest,
} from "@/lib/booking-request";

const mockedFindUnique = vi.mocked(prisma.bookingRequest.findUnique);
const mockedCreate = vi.mocked(prisma.bookingRequest.create);
const mockedUpdateMany = vi.mocked(prisma.bookingRequest.updateMany);
const mockedDeleteMany = vi.mocked(prisma.bookingRequest.deleteMany);
const mockedSettingsFindUnique = vi.mocked(prisma.bookingRequestSettings.findUnique);
const mockedSettingsUpsert = vi.mocked(prisma.bookingRequestSettings.upsert);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedSendVerification = vi.mocked(sendBookingRequestVerificationEmail);
const mockedSendAdminPending = vi.mocked(sendAdminBookingRequestPendingEmail);
const mockedSendApproved = vi.mocked(sendBookingRequestApprovedEmail);
const mockedSendDeclined = vi.mocked(sendBookingRequestDeclinedEmail);
const mockedLogAudit = vi.mocked(logAudit);
const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);

function memberNightConflictError() {
  return new BookingMemberNightConflictError([
    {
      memberId: "member-42",
      memberName: "Linked Member",
      bookingId: "existing-booking",
      bookingStatus: BookingStatus.CONFIRMED,
      bookingOwnerName: "Other Owner",
      bookingCheckIn: "2026-08-01",
      bookingCheckOut: "2026-08-03",
      guestId: "existing-guest",
      conflictingNights: ["2026-08-01"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: false,
    },
  ]);
}

const GUESTS = [{ firstName: "Tara", lastName: "Tester", ageTier: "ADULT" as const }];

function baseRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-1",
    type: "GENERAL",
    status: BookingRequestStatus.NEW,
    contactFirstName: "Tara",
    contactLastName: "Tester",
    contactEmail: "tara@example.com",
    contactPhone: null,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    guests: GUESTS,
    message: null,
    indicativePriceCents: null,
    priceCents: null,
    verificationTokenHash: null,
    verificationTokenExpiresAt: null,
    verifiedAt: null,
    pricedByMemberId: null,
    pricedAt: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    declineReason: null,
    convertedBookingId: null,
    convertedMemberId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("splitPriceAcrossGuests", () => {
  it("puts the remainder on the first guest", () => {
    expect(splitPriceAcrossGuests(1000, 3)).toEqual([334, 333, 333]);
  });

  it("returns an empty array for zero guests", () => {
    expect(splitPriceAcrossGuests(1000, 0)).toEqual([]);
  });

  it("handles an exact split", () => {
    expect(splitPriceAcrossGuests(900, 3)).toEqual([300, 300, 300]);
  });
});

describe("resolveRequestBookingHoldUntil", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  it("uses the standard hold when it leaves more than the minimum", () => {
    const checkIn = new Date("2026-08-01T00:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 7, now);
    expect(hold).toEqual(new Date("2026-07-25T00:00:00.000Z"));
  });

  it("guarantees at least 48 hours even for late approvals", () => {
    const checkIn = new Date("2026-07-02T00:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 7, now);
    // standardHold (2026-06-25) < minimumHold (2026-07-03), but never beyond check-in
    expect(hold).toEqual(checkIn);
  });

  it("never returns a hold after check-in", () => {
    const checkIn = new Date("2026-07-02T12:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 0, now);
    expect(hold.getTime()).toBeLessThanOrEqual(checkIn.getTime());
  });
});

describe("booking request settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to hidden pricing when no settings row exists", async () => {
    mockedSettingsFindUnique.mockResolvedValue(null);
    const settings = await getBookingRequestSettings();
    expect(settings).toEqual({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
  });

  it("updates and audits the pricing visibility setting", async () => {
    mockedSettingsUpsert.mockResolvedValue({
      id: "default",
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
    } as never);

    const result = await updateBookingRequestSettings({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
    });
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.settings_updated",
        actorMemberId: "admin-1",
      })
    );
  });
});

describe("createBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSettingsFindUnique.mockResolvedValue(null); // pricing hidden by default
    mockedCreate.mockResolvedValue(baseRequest({ id: "req-new" }) as never);
  });

  it("rejects an empty guest list", async () => {
    await expect(
      createBookingRequest({
        contactFirstName: "Tara",
        contactLastName: "Tester",
        contactEmail: "tara@example.com",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: [],
      })
    ).rejects.toThrow(BookingRequestError);

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rejects missing contact details", async () => {
    await expect(
      createBookingRequest({
        contactFirstName: "  ",
        contactLastName: "Tester",
        contactEmail: "tara@example.com",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: GUESTS,
      })
    ).rejects.toThrow(BookingRequestError);

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("creates a NEW request, stores only the token hash, and emails the raw token", async () => {
    await createBookingRequest({
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "Tara@Example.com",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: GUESTS,
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(createArgs.contactEmail).toBe("tara@example.com");
    expect(createArgs.indicativePriceCents).toBeNull();
    expect(createArgs.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/);

    expect(mockedSendVerification).toHaveBeenCalledTimes(1);
    const emailArgs = mockedSendVerification.mock.calls[0][0];
    expect(emailArgs.email).toBe("tara@example.com");
    // The raw token emailed to the requester must hash to the stored value,
    // and must never equal the stored hash itself.
    expect(hashActionToken(emailArgs.token)).toBe(createArgs.verificationTokenHash);
    expect(emailArgs.token).not.toBe(createArgs.verificationTokenHash);

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.submitted" })
    );
  });
});

describe("verifyBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid for an unknown token hash", async () => {
    mockedFindUnique.mockResolvedValue(null);
    const result = await verifyBookingRequest("a".repeat(64));
    expect(result).toEqual({ outcome: "invalid" });
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("returns expired when the verification window has passed", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.NEW,
        verificationTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }) as never
    );

    const result = await verifyBookingRequest("a".repeat(64));
    expect(result).toEqual({ outcome: "expired" });
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("returns already_verified without re-claiming when status is no longer NEW", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED }) as never
    );

    const result = await verifyBookingRequest("a".repeat(64));
    expect(result.outcome).toBe("already_verified");
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("claims NEW -> VERIFIED exactly once and notifies admins", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.NEW,
        verificationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const result = await verifyBookingRequest("a".repeat(64));

    expect(result.outcome).toBe("verified");
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: BookingRequestStatus.NEW },
      data: { status: BookingRequestStatus.VERIFIED, verifiedAt: expect.any(Date) },
    });
    expect(mockedSendAdminPending).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.verified" })
    );
  });

  it("falls back to already_verified when a concurrent verification wins the claim", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.NEW,
          verificationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }) as never
      )
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    const result = await verifyBookingRequest("a".repeat(64));

    expect(result.outcome).toBe("already_verified");
    expect(mockedSendAdminPending).not.toHaveBeenCalled();
  });
});

describe("priceBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects negative or non-integer prices", async () => {
    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: -1 })
    ).rejects.toThrow(BookingRequestError);
    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: 1.5 })
    ).rejects.toThrow(BookingRequestError);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      priceBookingRequest({ requestId: "missing", adminMemberId: "admin-1", priceCents: 1000 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sets PRICED on a VERIFIED request and audits the officer", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const updated = await priceBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      priceCents: 12000,
    });

    expect(updated?.priceCents).toBe(12000);
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: { in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED] } },
      data: {
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        pricedByMemberId: "admin-1",
        pricedAt: expect.any(Date),
      },
    });
  });

  it("rejects pricing a request that has already moved past PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.APPROVED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: 1000 })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("declineBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      declineBookingRequest({ requestId: "missing", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("declines a PRICED request, emails the requester, and audits the reviewer", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.PRICED }) as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.DECLINED, declineReason: "Fully booked" }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "Fully booked",
    });

    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
    expect(mockedSendDeclined).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com", reason: "Fully booked" })
    );
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.declined" })
    );
  });

  it("rejects declining a request that is not VERIFIED or PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.CONVERTED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      declineBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("approveBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
    // Default to no member-night conflict; individual tests override to reject.
    mockedAssertNoConflicts.mockResolvedValue(undefined);
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      approveBookingRequest({ requestId: "missing", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects approving a request that is not PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never);
    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects approving a PRICED request with no price set", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: null }) as never
    );
    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns capacityExceeded without converting when no beds remain", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -1 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 2 },
      ],
    } as never);

    const result = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(result).toEqual({ type: "capacityExceeded", fullNights: ["2026-08-01"] });
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(mockedSendApproved).not.toHaveBeenCalled();
  });

  it("converts a PRICED request into a non-login member, PENDING booking, payment and payment link", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "member-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(result).toMatchObject({
      type: "approved",
      requestId: "req-1",
      bookingId: "booking-1",
      memberId: "member-1",
      priceCents: 12000,
    });

    const memberArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(memberArgs.canLogin).toBe(false);
    expect(memberArgs.emailVerified).toBe(true);
    // General booking-request contacts are non-members, not paying members.
    expect(memberArgs.role).toBe("NON_MEMBER");

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("member-1");
    expect(bookingArgs.status).toBe(BookingStatus.PENDING);
    expect(bookingArgs.finalPriceCents).toBe(12000);

    const paymentArgs = vi.mocked(prisma.payment.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(paymentArgs.status).toBe(PaymentStatus.PENDING);
    expect(paymentArgs.bookingId).toBe("booking-1");

    const linkArgs = vi.mocked(prisma.paymentLink.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(linkArgs.bookingId).toBe("booking-1");
    expect(linkArgs.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    // The raw token emailed to the requester must not be the stored hash.
    const emailArgs = mockedSendApproved.mock.calls[0][0];
    expect(hashActionToken(emailArgs.token)).toBe(linkArgs.tokenHash);
    expect(emailArgs.token).not.toBe(linkArgs.tokenHash);

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.approved" })
    );
  });

  it("maps to an existing non-login contact instead of creating a new member (#1255)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    // The chosen contact is a valid non-login NON_MEMBER organisation contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "contact-9",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "contact-9",
    });

    expect(result).toMatchObject({
      type: "approved",
      memberId: "contact-9",
      bookingId: "booking-1",
    });
    // No new member (and therefore no new Xero contact) is minted on the map path.
    expect(prisma.member.create).not.toHaveBeenCalled();
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("contact-9");
  });

  it("rejects mapping a request onto a login-capable member (#1255 guard)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "real-member",
      canLogin: true,
      role: "USER",
      archivedAt: null,
    } as never);

    await expect(
      approveBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        ownerContactMemberId: "real-member",
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("is idempotent on a re-armed convertedBookingId: a replayed accept returns the existing booking and fires no second side effect (#1232)", async () => {
    // First accept: a clean PRICED request converts exactly once.
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "member-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const first = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });
    expect(first).toMatchObject({ type: "approved", bookingId: "booking-1", memberId: "member-1" });
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentLink.create).toHaveBeenCalledTimes(1);
    expect(mockedSendApproved).toHaveBeenCalledTimes(1);

    // Simulate the caller's line-~729 re-arm: the request is set back to PRICED
    // WITHOUT clearing convertedBookingId/convertedMemberId. Deliberately do NOT
    // reset mock history here — the whole money proof is that these counts stay
    // at one across the replay.
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        convertedBookingId: "booking-1",
        convertedMemberId: "member-1",
      }) as never
    );

    const replay = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    // Returns the SAME booking; nothing new is created; no second email.
    expect(replay).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      memberId: "member-1",
    });
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentLink.create).toHaveBeenCalledTimes(1);
    expect(mockedSendApproved).toHaveBeenCalledTimes(1);
    // The claim updateMany ran for the first accept only, never the replay.
    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    // Under the lock the replay re-asserts the terminal status to CONVERTED.
    const lastUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as Record<string, unknown>;
    expect(lastUpdate.status).toBe(BookingRequestStatus.CONVERTED);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.approve_idempotent_replay" })
    );
  });

  it("runs the member-night conflict guard with linked guests before creating anything (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "member-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorMemberId: "admin-1",
        actorRole: "ADMIN",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        excludeBookingId: undefined,
      })
    );
    const guardGuests = mockedAssertNoConflicts.mock.calls[0][1].guests;
    expect(guardGuests).toHaveLength(1);
    expect(guardGuests[0]).toMatchObject({
      memberId: "member-42",
      stayStart: new Date("2026-08-01T00:00:00.000Z"),
      stayEnd: new Date("2026-08-03T00:00:00.000Z"),
    });
  });

  it("blocks approval and creates nothing when a linked member double-books (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedAssertNoConflicts.mockRejectedValueOnce(memberNightConflictError());

    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(mockedSendApproved).not.toHaveBeenCalled();
  });

  it("passes the held booking id as excludeBookingId on the reuse path (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-member",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // Held owner is re-validated at conversion (#1255 decision 1); still valid,
    // so it is reused unchanged.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    // Held booking already has the request's guest rows; the reuse path updates
    // them in place (issue #1254) rather than deleteMany+recreate.
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ excludeBookingId: "held-1" })
    );
    // Reuse path preserves the held booking's guest rows (updates in place) and
    // does not destroy them, so bed allocations survive the accept (issue #1254).
    expect(prisma.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g1" } })
    );
    expect(prisma.bookingGuest.deleteMany).not.toHaveBeenCalled();
    // Reuse path updates the held booking rather than creating a fresh one.
    expect(prisma.booking.update).toHaveBeenCalled();
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("ignores ownerContactMemberId on a held request and reuses a still-valid held owner (#1255/#1280)", async () => {
    // Once beds are held, the owner was materialised earlier (at hold/quote-send)
    // and persisted on the held booking. Approval reuses held.memberId and does
    // NOT re-run the map-or-create decision — the passed contact id is a no-op.
    // Decision 1 (#1255): the held owner IS re-validated at conversion; a
    // still-valid owner is reused unchanged (no substitution, no new member).
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-member",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // Re-validation of the held owner: still a valid non-login contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "some-other-contact",
    });

    // Owner stays the held booking's owner, not the passed contact.
    expect(result).toMatchObject({ type: "approved", memberId: "held-member" });
    // The guard re-validated the HELD owner (not the passed param); still valid,
    // so no fresh member was minted and no substitution was recorded.
    expect(prisma.member.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "held-member" } })
    );
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.owner_substituted" })
    );
  });

  it("substitutes a fresh contact when the held owner is no longer valid at conversion, and the accept still succeeds (#1255 decision 1)", async () => {
    // A mapped pre-existing contact was login-enabled/archived during the
    // quote→accept window. Re-validation fails, so instead of failing the
    // requester's accept the held booking is re-owned by a fresh non-login
    // contact and an admin-attention audit row is written.
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      memberId: "held-invalid",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // The held owner became login-capable → guard rejects it.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-invalid",
      canLogin: true,
      role: "USER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "fresh-owner" } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // Accept succeeds; the booking is now owned by the fresh substitute.
    expect(result).toMatchObject({ type: "approved", memberId: "fresh-owner" });
    const freshArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(freshArgs.canLogin).toBe(false);
    expect(freshArgs.role).toBe("NON_MEMBER");
    // The held booking is repointed at the substitute owner.
    const updateArgs = vi.mocked(prisma.booking.update).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(updateArgs.memberId).toBe("fresh-owner");
    // Admin-attention audit row recording the substitution.
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.owner_substituted",
        metadata: expect.objectContaining({
          invalidMemberId: "held-invalid",
          substituteMemberId: "fresh-owner",
        }),
      })
    );
  });
});

describe("assertMappableOwnerContact (real #1255 guard)", () => {
  function txWith(contact: Record<string, unknown> | null) {
    return {
      member: { findUnique: vi.fn().mockResolvedValue(contact) },
    } as never;
  }

  it("returns the id for a valid non-login NON_MEMBER contact", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: null,
          active: true,
        }),
        "c1"
      )
    ).resolves.toBe("c1");
  });

  it("returns the id for a valid non-login SCHOOL contact (cross-type allowed, #1255 decision 2)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "s1",
          canLogin: false,
          role: "SCHOOL",
          archivedAt: null,
          active: true,
        }),
        "s1"
      )
    ).resolves.toBe("s1");
  });

  it("throws 404 when the contact does not exist", async () => {
    await expect(
      assertMappableOwnerContact(txWith(null), "missing")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a login-capable member (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({ id: "m1", canLogin: true, role: "USER", archivedAt: null, active: true }),
        "m1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a role that is neither NON_MEMBER nor SCHOOL (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({ id: "m1", canLogin: false, role: "USER", archivedAt: null, active: true }),
        "m1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an archived contact (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: new Date("2026-01-01T00:00:00.000Z"),
          active: true,
        }),
        "c1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an inactive contact (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: null,
          active: false,
        }),
        "c1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("purgeExpiredBookingRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges declined and never-verified requests past the retention window and audits the result", async () => {
    mockedDeleteMany.mockResolvedValueOnce({ count: 2 } as never).mockResolvedValueOnce({ count: 3 } as never);

    const now = new Date("2026-09-01T00:00:00.000Z");
    const result = await purgeExpiredBookingRequests(now);

    expect(result).toEqual({ declinedPurged: 2, neverVerifiedPurged: 3 });

    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(mockedDeleteMany).toHaveBeenNthCalledWith(1, {
      where: { status: BookingRequestStatus.DECLINED, updatedAt: { lte: cutoff } },
    });
    expect(mockedDeleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: BookingRequestStatus.NEW,
        verifiedAt: null,
        createdAt: { lte: cutoff },
      },
    });
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.retention_purge",
        metadata: expect.objectContaining({ declinedPurged: 2, neverVerifiedPurged: 3 }),
      })
    );
  });

  it("does not write an audit log when nothing was purged", async () => {
    mockedDeleteMany.mockResolvedValue({ count: 0 } as never);

    const result = await purgeExpiredBookingRequests(new Date("2026-09-01T00:00:00.000Z"));

    expect(result).toEqual({ declinedPurged: 0, neverVerifiedPurged: 0 });
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });
});
