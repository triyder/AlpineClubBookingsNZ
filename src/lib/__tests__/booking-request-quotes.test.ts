import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgeTier,
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  SchoolCateringOption,
} from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prismaMock: {
    bookingRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingRequestQuote: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    bookingGuest: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
  mockApproveBookingRequest: vi.fn(),
  mockApproveSchoolBookingRequest: vi.fn(),
  mockSendQuoteEmail: vi.fn(),
  mockGetSettings: vi.fn(),
}));

const mockApproveBookingRequest = mocks.mockApproveBookingRequest;
const mockSendQuoteEmail = mocks.mockSendQuoteEmail;

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prismaMock }));

vi.mock("@/lib/booking-request", () => {
  class BookingRequestError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "BookingRequestError";
      this.status = status;
    }
  }

  return {
    BookingRequestError,
    parseBookingRequestGuests: (raw: unknown) => raw,
    parseBookingRequestLinkedGuestMembers: (raw: unknown) => raw ?? [],
    linkedGuestMemberMap: (raw: unknown) =>
      new Map(
        Array.isArray(raw)
          ? raw.map((link: { guestIndex: number; memberId: string }) => [
              link.guestIndex,
              link.memberId,
            ])
          : []
      ),
    splitPriceAcrossGuests: (totalCents: number, guestCount: number) => {
      if (guestCount <= 0) return [];
      const base = Math.floor(totalCents / guestCount);
      const remainder = totalCents - base * guestCount;
      return Array.from({ length: guestCount }, (_, index) =>
        index === 0 ? base + remainder : base
      );
    },
    approveBookingRequest: (...args: unknown[]) =>
      mocks.mockApproveBookingRequest(...args),
    getBookingRequestSettings: (...args: unknown[]) =>
      mocks.mockGetSettings(...args),
    MAPPABLE_CONTACT_ROLES: ["NON_MEMBER", "SCHOOL"] as const,
    // Faithful re-implementation of the #1255 guard so the hold map/reject
    // paths are actually exercised (the real module is fully mocked here).
    assertMappableOwnerContact: async (
      tx: {
        member: {
          findUnique: (args: unknown) => Promise<{
            id: string;
            canLogin: boolean;
            role: string;
            archivedAt: Date | null;
            active: boolean;
          } | null>;
        };
      },
      ownerContactMemberId: string
    ) => {
      const contact = await tx.member.findUnique({
        where: { id: ownerContactMemberId },
        select: { id: true, canLogin: true, role: true, archivedAt: true, active: true },
      });
      if (!contact) {
        throw new BookingRequestError("The selected contact could not be found", 404);
      }
      if (contact.canLogin) {
        throw new BookingRequestError("login-capable member", 422);
      }
      if (contact.role !== "NON_MEMBER" && contact.role !== "SCHOOL") {
        throw new BookingRequestError("not an org contact", 422);
      }
      if (contact.archivedAt) {
        throw new BookingRequestError("archived contact", 422);
      }
      if (!contact.active) {
        throw new BookingRequestError("inactive contact", 422);
      }
      return contact.id;
    },
  };
});

vi.mock("@/lib/school-booking-request", () => ({
  approveSchoolBookingRequest: (...args: unknown[]) =>
    mocks.mockApproveSchoolBookingRequest(...args),
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestQuoteEmail: (...args: unknown[]) =>
    mocks.mockSendQuoteEmail(...args),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn().mockResolvedValue({ available: true, nightDetails: [] }),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

// Keep the real BookingMemberNightConflictError; only the assertion is a spy.
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
  createBookingRequestQuote,
  getBookingRequestQuoteContext,
  holdBookingRequestSlots,
  respondToBookingRequestQuote,
  sendBookingRequestQuote,
} from "@/lib/booking-request-quotes";
import { hashActionToken } from "@/lib/action-tokens";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedReconcile = vi.mocked(reconcileBedAllocationsForBooking);

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

const GUESTS = [
  { firstName: "Tara", lastName: "Tester", ageTier: AgeTier.ADULT },
  { firstName: "Sam", lastName: "Student", ageTier: AgeTier.CHILD },
];

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: BookingRequestType.GENERAL,
    status: BookingRequestStatus.VERIFIED,
    cateringPreference: null,
    contactFirstName: "Tara",
    contactLastName: "Tester",
    contactEmail: "tara@example.test",
    contactPhone: null,
    schoolName: null,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    guests: GUESTS,
    linkedGuestMembers: null,
    message: null,
    priceCents: null,
    heldBookingId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockGetSettings.mockResolvedValue({
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
  });
  vi.mocked(prisma.$transaction).mockImplementation((async (callback: never) =>
    (callback as (tx: typeof prisma) => Promise<unknown>)(prisma)) as never
  );
});

describe("createBookingRequestQuote", () => {
  it("creates a new overall-total quote version and supersedes active versions", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(baseRequest() as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({ version: 1 } as never);
    vi.mocked(prisma.bookingRequestQuote.create).mockResolvedValue({
      id: "quote-2",
      bookingRequestId: "req-1",
      version: 2,
      status: BookingRequestQuoteStatus.DRAFT,
      pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
      options: [],
    } as never);

    await createBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
      quote: {
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        options: [{ id: "STANDARD", totalCents: 12345 }],
      },
    });

    expect(prisma.bookingRequestQuote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingRequestId: "req-1",
          status: { in: [BookingRequestQuoteStatus.DRAFT, BookingRequestQuoteStatus.SENT] },
        }),
        data: expect.objectContaining({
          status: BookingRequestQuoteStatus.SUPERSEDED,
        }),
      })
    );
    expect(prisma.bookingRequestQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 2,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          options: expect.arrayContaining([
            expect.objectContaining({ id: "STANDARD", totalCents: 12345 }),
          ]),
        }),
      })
    );
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingRequestStatus.QUOTED,
          priceCents: 12345,
        }),
      })
    );
  });

  it("calculates per guest-night totals using linked member rates", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(baseRequest() as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([{ id: "member-1" }] as never);
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.bookingRequestQuote.create).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      pricingMode: BookingRequestPricingMode.PER_GUEST_NIGHT,
      options: [],
    } as never);

    await createBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
      quote: {
        pricingMode: BookingRequestPricingMode.PER_GUEST_NIGHT,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-1" }],
        options: [
          {
            id: "STANDARD",
            guestNightRates: [
              { ageTier: AgeTier.ADULT, isMember: true, rateCents: 3000 },
              { ageTier: AgeTier.CHILD, isMember: false, rateCents: 1500 },
            ],
          },
        ],
      },
    });

    const createData = vi.mocked(prisma.bookingRequestQuote.create).mock.calls[0][0]
      .data as unknown as { options: Array<{ totalCents: number }> };
    expect(createData.options[0].totalCents).toBe(9000);
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          linkedGuestMembers: [{ guestIndex: 0, memberId: "member-1" }],
        }),
      })
    );
  });

  it("requires school quote options to match the catering preference", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.SCHOOL,
        cateringPreference: "CATERED",
      }) as never
    );

    await expect(
      createBookingRequestQuote({
        requestId: "req-1",
        adminMemberId: "admin-1",
        quote: {
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          options: [
            {
              cateringOption: SchoolCateringOption.NON_CATERED,
              totalCents: 1000,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("sendBookingRequestQuote", () => {
  it("stores only the response token hash and emails the raw token", async () => {
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 1000,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      message: null,
      createdByMemberId: "admin-1",
      bookingRequest: baseRequest(),
    } as never);
    vi.mocked(prisma.bookingRequestQuote.update).mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      options: [],
      responseTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    } as never);
    // Auto-hold on send (#1254): the request already holds a live
    // AWAITING_REVIEW booking, so holdBookingRequestSlots re-validates it and
    // short-circuits (reused); the send proceeds.
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ heldBookingId: "held-1", quotes: [] }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      status: "AWAITING_REVIEW",
    } as never);

    await sendBookingRequestQuote({ requestId: "req-1", adminMemberId: "admin-1" });

    const updateData = vi.mocked(prisma.bookingRequestQuote.update).mock.calls[0][0]
      .data as { responseTokenHash: string };
    const emailArgs = mockSendQuoteEmail.mock.calls[0][0] as { token: string };
    expect(updateData.responseTokenHash).toBe(hashActionToken(emailArgs.token));
  });

  function mockDraftQuoteForSend() {
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 1000,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      message: null,
      createdByMemberId: "admin-1",
      bookingRequest: baseRequest(),
    } as never);
    vi.mocked(prisma.bookingRequestQuote.update).mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      options: [],
      responseTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    } as never);
    // Auto-hold on send (#1254): the request already holds a live
    // AWAITING_REVIEW booking, so the hold re-validates and short-circuits
    // (reused); the send proceeds.
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ heldBookingId: "held-1", quotes: [] }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      status: "AWAITING_REVIEW",
    } as never);
  }

  it("reports emailDelivered true when the quote email sends", async () => {
    mockDraftQuoteForSend();
    mockSendQuoteEmail.mockResolvedValue(undefined);

    const result = await sendBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(result.emailDelivered).toBe(true);
  });

  it("threads a mapped owner contact through the auto-hold placed on send (#1255)", async () => {
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 1000,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      message: null,
      createdByMemberId: "admin-1",
      bookingRequest: baseRequest(),
    } as never);
    vi.mocked(prisma.bookingRequestQuote.update).mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      options: [],
      responseTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    } as never);
    // No existing hold, so send materialises a fresh owner — and must honour the
    // admin's map-to-existing decision rather than minting a new contact.
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
      }) as never
    );
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "existing-contact",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "held-1" } as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);
    mockSendQuoteEmail.mockResolvedValue(undefined);

    await sendBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "existing-contact",
    });

    expect(prisma.member.create).not.toHaveBeenCalled();
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.memberId).toBe("existing-contact");
  });

  it("still marks the quote SENT but reports emailDelivered false when delivery fails", async () => {
    mockDraftQuoteForSend();
    mockSendQuoteEmail.mockRejectedValue(new Error("SES unavailable"));

    const result = await sendBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(result.emailDelivered).toBe(false);
    const updateData = vi.mocked(prisma.bookingRequestQuote.update).mock.calls[0][0]
      .data as { status: BookingRequestQuoteStatus };
    expect(updateData.status).toBe(BookingRequestQuoteStatus.SENT);
  });

  it("applies the admin-configured response window and resets the reminder flag", async () => {
    mockDraftQuoteForSend();
    mockSendQuoteEmail.mockResolvedValue(undefined);
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 7,
      quoteReminderLeadDays: 2,
    });

    const before = Date.now();
    const result = await sendBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    const expiresMs = result.responseTokenExpiresAt.getTime() - before;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(expiresMs).toBeLessThan(sevenDaysMs + 60_000);

    const updateData = vi.mocked(prisma.bookingRequestQuote.update).mock.calls[0][0]
      .data as { reminderSentAt: Date | null };
    expect(updateData.reminderSentAt).toBeNull();
  });

  it("blocks the send and does not mark SENT when the lodge is at capacity (issue #1254)", async () => {
    // A DRAFT quote exists, but no hold is placed yet, so the send must first
    // reserve the beds. When capacity is gone the send fails loudly instead of
    // promising unreserved dates.
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      options: [],
      message: null,
      createdByMemberId: "admin-1",
      bookingRequest: baseRequest(),
    } as never);
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ priceCents: 12000, quotes: [] }) as never
    );
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValueOnce({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), occupiedBeds: 10, availableBeds: -1 },
      ],
    } as never);

    await expect(
      sendBookingRequestQuote({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });

    // Quote is not marked SENT and no email goes out for an unreservable quote.
    expect(prisma.bookingRequestQuote.update).not.toHaveBeenCalled();
    expect(mockSendQuoteEmail).not.toHaveBeenCalled();
  });
});

describe("public quote response", () => {
  it("returns quote context for a valid token", async () => {
    const token = "a".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 1000,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      bookingRequest: baseRequest(),
    } as never);

    const context = await getBookingRequestQuoteContext(token);

    expect(context.options[0].totalCents).toBe(1000);
    expect(prisma.bookingRequestQuote.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { responseTokenHash: hashActionToken(token) },
      })
    );
  });

  it("cancels the held booking, frees its beds, and detaches heldBookingId (issue #1254)", async () => {
    const token = "c".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      createdByMemberId: "admin-1",
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 1000,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      bookingRequest: baseRequest({ heldBookingId: "held-1" }),
    } as never);

    const result = await respondToBookingRequestQuote({ token, action: "CANCEL" });

    expect(result).toEqual({ outcome: "cancelled" });
    // The reserved hold is released so it stops consuming capacity...
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "held-1" },
        data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
      })
    );
    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "held-1" })
    );
    // ...and the pointer is detached so a future re-hold can never reuse it.
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { heldBookingId: null } })
    );
  });

  it("accepts a quote through the existing general conversion path", async () => {
    const token = "b".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      createdByMemberId: "admin-1",
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 2500,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      bookingRequest: baseRequest(),
    } as never);
    mockApproveBookingRequest.mockResolvedValue({
      type: "approved",
      bookingId: "booking-1",
      memberId: "member-1",
      priceCents: 2500,
      paymentLinkExpiresAt: new Date(),
    });

    const result = await respondToBookingRequestQuote({
      token,
      action: "ACCEPT",
      optionId: "STANDARD",
    });

    expect(result).toMatchObject({ outcome: "accepted", bookingId: "booking-1" });
    expect(prisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingRequestStatus.PRICED,
          acceptedQuoteId: "quote-1",
          acceptedPriceCents: 2500,
        }),
      })
    );
    expect(mockApproveBookingRequest).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });
    expect(prisma.bookingRequestQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingRequestQuoteStatus.ACCEPTED,
        }),
      })
    );
  });

  it("rejects an expired token with a distinct 410 status", async () => {
    const token = "c".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      status: BookingRequestQuoteStatus.SENT,
      responseTokenExpiresAt: new Date(Date.now() - 60_000),
      options: [],
      bookingRequest: baseRequest(),
    } as never);

    await expect(getBookingRequestQuoteContext(token)).rejects.toMatchObject({
      status: 410,
      message: "This quote has expired.",
    });
  });

  it("rejects a superseded quote with a 409 'no longer active' status", async () => {
    const token = "d".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      status: BookingRequestQuoteStatus.SUPERSEDED,
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [],
      bookingRequest: baseRequest(),
    } as never);

    await expect(getBookingRequestQuoteContext(token)).rejects.toMatchObject({
      status: 409,
      message: "This quote is no longer active.",
    });
  });

  it("reverts to QUOTE_SENT and names the full nights when capacity is lost on accept", async () => {
    const token = "e".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      createdByMemberId: "admin-1",
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [
        {
          id: "STANDARD",
          label: "Quote",
          cateringOption: null,
          totalCents: 2500,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        },
      ],
      bookingRequest: baseRequest(),
    } as never);
    mockApproveBookingRequest.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: ["2026-08-01", "2026-08-02"],
    });

    await expect(
      respondToBookingRequestQuote({ token, action: "ACCEPT", optionId: "STANDARD" })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("2026-08-01, 2026-08-02"),
    });

    expect(prisma.bookingRequest.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingRequestStatus.QUOTE_SENT,
          acceptedQuoteId: null,
          acceptedPriceCents: null,
        }),
      })
    );
  });
});

describe("holdBookingRequestSlots owner role", () => {
  beforeEach(() => {
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "owner-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "held-1" } as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);
    // Default to no member-night conflict; individual tests override to reject.
    mockedAssertNoConflicts.mockResolvedValue(undefined);
  });

  it("creates a NON_MEMBER owner record for general booking requests", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
      }) as never
    );

    await holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" });

    const memberArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(memberArgs.role).toBe("NON_MEMBER");
    expect(memberArgs.canLogin).toBe(false);
  });

  it("creates a SCHOOL owner record for school booking requests", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.SCHOOL,
        schoolName: "New Plymouth Primary School",
        priceCents: 12000,
        quotes: [],
      }) as never
    );

    await holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" });

    const memberArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(memberArgs.role).toBe("SCHOOL");
    expect(memberArgs.firstName).toBe("New Plymouth Primary School");
  });

  it("maps the hold owner to an existing non-login contact instead of creating one (#1255)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
      }) as never
    );
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "existing-contact",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);

    const result = await holdBookingRequestSlots({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "existing-contact",
    });

    expect(result).toMatchObject({ type: "held", bookingId: "held-1" });
    // No new owner member is created on the map path.
    expect(prisma.member.create).not.toHaveBeenCalled();
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.memberId).toBe("existing-contact");
  });

  it("rejects holding onto a login-capable member (#1255 guard)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
      }) as never
    );
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "real-member",
      canLogin: true,
      role: "USER",
      archivedAt: null,
    } as never);

    await expect(
      holdBookingRequestSlots({
        requestId: "req-1",
        adminMemberId: "admin-1",
        ownerContactMemberId: "real-member",
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("runs the member-night conflict guard with linked guests and no exclusion before creating the hold (issue #1158)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );

    await holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorMemberId: "admin-1",
        actorRole: "ADMIN",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
      })
    );
    const guardArgs = mockedAssertNoConflicts.mock.calls[0][1];
    // A brand-new held booking is created, so nothing is excluded.
    expect(guardArgs).not.toHaveProperty("excludeBookingId");
    expect(guardArgs.guests).toHaveLength(2);
    expect(guardArgs.guests[0]).toMatchObject({
      memberId: "member-42",
      stayStart: new Date("2026-08-01T00:00:00.000Z"),
      stayEnd: new Date("2026-08-03T00:00:00.000Z"),
    });
  });

  it("blocks the hold and creates nothing when a linked member double-books (issue #1158)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedAssertNoConflicts.mockRejectedValueOnce(memberNightConflictError());

    await expect(
      holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("reuses the existing hold when the held booking is still AWAITING_REVIEW (issue #1254)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
        heldBookingId: "held-live",
      }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      status: "AWAITING_REVIEW",
    } as never);

    const result = await holdBookingRequestSlots({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({
      type: "held",
      bookingId: "held-live",
      reused: true,
    });
    // A live hold is reused verbatim — nothing detached, nothing recreated.
    expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("detaches a dead heldBookingId and creates a fresh hold when the pointed-to booking is no longer AWAITING_REVIEW (issue #1254)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
        heldBookingId: "dead-hold",
      }) as never
    );
    // The pointed-to hold was cancelled (e.g. an admin cancelled it on the
    // bed board), so the pointer is stale.
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      status: "CANCELLED",
    } as never);

    const result = await holdBookingRequestSlots({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // The dangling pointer is detached...
    expect(prisma.bookingRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-1", heldBookingId: "dead-hold" },
        data: { heldBookingId: null },
      })
    );
    // ...and a brand-new hold is created rather than reusing the dead row.
    expect(prisma.booking.create).toHaveBeenCalled();
    expect(result).toEqual({
      type: "held",
      bookingId: "held-1",
      reused: false,
    });
  });
});
