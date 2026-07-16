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
      findMany: vi.fn().mockResolvedValue([]),
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
      findMany: vi.fn(),
    },
    lodge: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    // Rate resolver (#1930, E4): the hold path snapshots each guest's rate
    // membership type at create time (linked members via assignments; unlinked
    // guests resolve to the built-in NON_MEMBER type).
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL" },
        { id: "type-nonmember", key: "NON_MEMBER" },
      ]),
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
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
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
  findLinkedGuestMemberNightConflicts,
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
  vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "lodge-1" } as never);
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
    // #1504 claim-first guard: request still quoteable, so the guarded updateMany
    // claims it (count 1) and the send proceeds.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);

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
    // #1504 claim-first guard: the request is still in a quoteable state, so the
    // status-guarded updateMany claims it (count 1) and the send proceeds.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 1 } as never);
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

  it("409s a re-send and sends no email when a concurrent decline finalised the request (#1504)", async () => {
    // Narrow TOCTOU: an admin re-sends a SENT quote while a concurrent admin
    // decline moves the request to DECLINED (releasing its hold) in the window
    // after holdBookingRequestSlots' own status check. The re-send's
    // status-guarded updateMany (status in the quoteable set) claims NOTHING
    // (count 0), so it throws 409 BEFORE marking the quote SENT and BEFORE the
    // email — the DECLINED request is never resurrected to QUOTE_SENT.
    vi.mocked(prisma.bookingRequestQuote.findFirst).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
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
      bookingRequest: baseRequest({ status: BookingRequestStatus.DECLINED }),
    } as never);
    // Hold was placed/reused before the decline released it; the re-send reaches
    // its transaction, where the guard is the last line of defence.
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ heldBookingId: "held-1", quotes: [] }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      status: "AWAITING_REVIEW",
    } as never);
    // The concurrent decline already moved the row off the quoteable set, so the
    // guarded claim matches zero rows.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(
      sendBookingRequestQuote({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });

    // The request was never resurrected: the guarded claim targeted QUOTE_SENT
    // but only for still-quoteable rows (DECLINED excluded), and because it
    // claimed nothing the quote is not marked SENT and no email is delivered.
    const guardCall = vi.mocked(prisma.bookingRequest.updateMany).mock.calls[0][0] as {
      where: { status: { in: BookingRequestStatus[] } };
      data: { status: BookingRequestStatus };
    };
    expect(guardCall.data.status).toBe(BookingRequestStatus.QUOTE_SENT);
    expect(guardCall.where.status.in).toContain(BookingRequestStatus.QUOTE_SENT);
    expect(guardCall.where.status.in).not.toContain(BookingRequestStatus.DECLINED);
    expect(prisma.bookingRequestQuote.update).not.toHaveBeenCalled();
    expect(mockSendQuoteEmail).not.toHaveBeenCalled();
  });

  it("still sends when the request is in a live quoteable state (#1504 happy path)", async () => {
    mockDraftQuoteForSend();
    mockSendQuoteEmail.mockResolvedValue(undefined);

    const result = await sendBookingRequestQuote({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // The claim-first guard passed (count 1): the quote is marked SENT and the
    // email is delivered, so a legitimate re-send is unaffected.
    const guardCall = vi.mocked(prisma.bookingRequest.updateMany).mock.calls.at(-1)?.[0] as {
      where: { status: { in: BookingRequestStatus[] } };
      data: { status: BookingRequestStatus };
    };
    expect(guardCall.data.status).toBe(BookingRequestStatus.QUOTE_SENT);
    expect(guardCall.where.status.in).not.toContain(BookingRequestStatus.DECLINED);
    expect(guardCall.where.status.in).not.toContain(BookingRequestStatus.CANCELLED);
    const updateData = vi.mocked(prisma.bookingRequestQuote.update).mock.calls[0][0]
      .data as { status: BookingRequestQuoteStatus };
    expect(updateData.status).toBe(BookingRequestQuoteStatus.SENT);
    expect(result.emailDelivered).toBe(true);
    expect(mockSendQuoteEmail).toHaveBeenCalledTimes(1);
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
    // #1423: the request status update is now a status-guarded updateMany that
    // runs FIRST (lock BookingRequest before the quote); a live request claims it.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 1,
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
      expect.objectContaining({
        data: { heldBookingId: null, version: { increment: 1 } },
      })
    );
  });

  it("409s a CANCEL on an already-finalised request and touches neither quote nor hold (#1423)", async () => {
    // In-flight window: the requester POST loaded the quote as SENT a moment
    // before a concurrent admin decline finalised the request (and released its
    // hold). The status-guarded claim (notIn [DECLINED, CANCELLED, CONVERTED,
    // APPROVED]) claims nothing, so CANCEL must not overwrite DECLINED -> CANCELLED
    // nor re-touch the hold.
    const token = "k".repeat(64);
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
      id: "quote-1",
      bookingRequestId: "req-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      createdByMemberId: "admin-1",
      responseTokenExpiresAt: new Date(Date.now() + 60_000),
      options: [],
      bookingRequest: baseRequest({
        status: BookingRequestStatus.DECLINED,
        heldBookingId: "held-1",
      }),
    } as never);
    // The request is already finalised: the guarded claim matches nothing.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    await expect(
      respondToBookingRequestQuote({ token, action: "CANCEL" })
    ).rejects.toMatchObject({ status: 409 });

    // Neither the quote nor the hold is touched.
    expect(prisma.bookingRequestQuote.update).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(mockedReconcile).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.update).not.toHaveBeenCalled();
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
    // #1423: the re-arm to PRICED is a status-guarded updateMany; a live
    // (non-finalised) request claims it.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    const result = await respondToBookingRequestQuote({
      token,
      action: "ACCEPT",
      optionId: "STANDARD",
    });

    expect(result).toMatchObject({ outcome: "accepted", bookingId: "booking-1" });
    expect(prisma.bookingRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "req-1",
          status: {
            notIn: [
              BookingRequestStatus.DECLINED,
              BookingRequestStatus.CANCELLED,
            ],
          },
        }),
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

  it("refuses to resurrect a request an admin already declined/cancelled (#1423)", async () => {
    // Decline-wins-first race: the admin decline finalised the request to
    // DECLINED/CANCELLED and released its hold AFTER this accept passed the
    // SENT-token check. The status-guarded re-arm (notIn [DECLINED, CANCELLED])
    // must claim NOTHING (count 0) → 409, and NEVER call approve/convert, so no
    // new booking + Payment + PaymentLink is minted off a declined request.
    const token = "f".repeat(64);
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
      bookingRequest: baseRequest({ status: BookingRequestStatus.DECLINED }),
    } as never);
    // The guard finds the request already finalised → nothing to re-arm.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    await expect(
      respondToBookingRequestQuote({ token, action: "ACCEPT", optionId: "STANDARD" })
    ).rejects.toMatchObject({ status: 409 });

    // No conversion, no booking, no quote flip to ACCEPTED.
    expect(mockApproveBookingRequest).not.toHaveBeenCalled();
    expect(mocks.mockApproveSchoolBookingRequest).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.bookingRequestQuote.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingRequestQuoteStatus.ACCEPTED,
        }),
      })
    );
  });

  it("re-arms an already-CONVERTED request so approve's #1232 replay returns the existing booking (#1423)", async () => {
    // Double-accept idempotency (#1232): a CONVERTED request passes the
    // notIn [DECLINED, CANCELLED] guard (count 1), so approve runs and its
    // convertedBookingId replay returns the ONE existing booking rather than
    // minting a second one. The guard must not break this pre-existing behaviour.
    const token = "g".repeat(64);
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
      bookingRequest: baseRequest({ status: BookingRequestStatus.CONVERTED }),
    } as never);
    // CONVERTED is NOT in [DECLINED, CANCELLED], so the guard claims it.
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    // approve replays the existing booking (real approve does this off
    // convertedBookingId under the advisory lock).
    mockApproveBookingRequest.mockResolvedValue({
      type: "approved",
      bookingId: "existing-booking-1",
      memberId: "member-1",
      priceCents: 2500,
      paymentLinkExpiresAt: new Date(),
    });

    const result = await respondToBookingRequestQuote({
      token,
      action: "ACCEPT",
      optionId: "STANDARD",
    });

    expect(result).toMatchObject({
      outcome: "accepted",
      bookingId: "existing-booking-1",
    });
    expect(mockApproveBookingRequest).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });
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
    // #1423: the initial re-arm to PRICED claims (the request is still live);
    // the capacity loss then reverts it to QUOTE_SENT via a status-guarded
    // updateMany (both are prisma.bookingRequest.updateMany, so count 1 covers
    // the re-arm and the revert).
    vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    await expect(
      respondToBookingRequestQuote({ token, action: "ACCEPT", optionId: "STANDARD" })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("2026-08-01, 2026-08-02"),
    });

    expect(prisma.bookingRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "req-1",
          status: {
            notIn: [
              BookingRequestStatus.DECLINED,
              BookingRequestStatus.CANCELLED,
            ],
          },
        }),
        data: expect.objectContaining({
          status: BookingRequestStatus.QUOTE_SENT,
          acceptedQuoteId: null,
          acceptedPriceCents: null,
        }),
      })
    );
  });

  it("does NOT un-decline a request the admin declined concurrently when a losing accept reverts (#1423)", async () => {
    // decline-wins-first during accept: the request was finalised to DECLINED
    // after this accept re-armed it to PRICED. approve loses on capacity and the
    // revert runs — but its status-guarded updateMany (notIn [DECLINED,
    // CANCELLED]) claims NOTHING (count 0), so the DECLINED request is never
    // un-declined back to QUOTE_SENT. The accept still 409s via capacityExceeded.
    const token = "h".repeat(64);
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
      fullNights: ["2026-08-01"],
    });
    // First call (step-1 re-arm) claims; second call (the revert) finds the
    // request already DECLINED and claims nothing.
    vi.mocked(prisma.bookingRequest.updateMany)
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValue({ count: 0 } as never);

    await expect(
      respondToBookingRequestQuote({ token, action: "ACCEPT", optionId: "STANDARD" })
    ).rejects.toMatchObject({ status: 409 });

    // The revert was attempted with the finalisation guard and simply claimed
    // nothing — never a plain update that could un-decline.
    expect(prisma.bookingRequest.update).not.toHaveBeenCalled();
    expect(prisma.bookingRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: [
              BookingRequestStatus.DECLINED,
              BookingRequestStatus.CANCELLED,
            ],
          },
        }),
        data: expect.objectContaining({
          status: BookingRequestStatus.QUOTE_SENT,
        }),
      })
    );
  });

  it.each([
    ["MODIFY", "modification_requested", BookingRequestStatus.MODIFICATION_REQUESTED],
    ["QUERY", "query_sent", BookingRequestStatus.QUERY_PENDING],
  ] as const)(
    "processes a requester %s on a live QUOTE_SENT request (guarded re-status still passes)",
    async (action, outcome, expectedStatus) => {
      const token = "j".repeat(64);
      vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
        id: "quote-1",
        bookingRequestId: "req-1",
        version: 1,
        status: BookingRequestQuoteStatus.SENT,
        createdByMemberId: "admin-1",
        responseTokenExpiresAt: new Date(Date.now() + 60_000),
        options: [],
        bookingRequest: baseRequest({ status: BookingRequestStatus.QUOTE_SENT }),
      } as never);
      // Live request: the guarded re-status claims it.
      vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
        count: 1,
      } as never);

      const result = await respondToBookingRequestQuote({
        token,
        action,
        message: "please change dates",
      });

      expect(result).toMatchObject({ outcome });
      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expectedStatus }),
        })
      );
      expect(prisma.bookingRequestQuote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingRequestQuoteStatus.SUPERSEDED,
          }),
        })
      );
    }
  );

  it.each(["MODIFY", "QUERY"] as const)(
    "refuses a requester %s once the request was declined/cancelled (#1423)",
    async (action) => {
      // decline-wins-first for the MODIFY/QUERY branch: a POST that loaded the
      // SENT quote just before the decline retired it must not resurrect the
      // finalised request. The status-guarded updateMany (notIn [DECLINED,
      // CANCELLED]) claims nothing → 409, and the throw rolls back the quote
      // supersede in the same transaction.
      const token = "i".repeat(64);
      vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue({
        id: "quote-1",
        bookingRequestId: "req-1",
        version: 1,
        status: BookingRequestQuoteStatus.SENT,
        createdByMemberId: "admin-1",
        responseTokenExpiresAt: new Date(Date.now() + 60_000),
        options: [],
        bookingRequest: baseRequest({ status: BookingRequestStatus.DECLINED }),
      } as never);
      // The request is already finalised: the guarded re-status claims nothing.
      vi.mocked(prisma.bookingRequest.updateMany).mockResolvedValue({
        count: 0,
      } as never);

      await expect(
        respondToBookingRequestQuote({ token, action, message: "hello" })
      ).rejects.toMatchObject({ status: 409 });

      // Guarded updateMany (not a plain update) and no booking mutation.
      expect(prisma.bookingRequest.update).not.toHaveBeenCalled();
      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "req-1",
            status: {
              notIn: [
                BookingRequestStatus.DECLINED,
                BookingRequestStatus.CANCELLED,
              ],
            },
          }),
        })
      );
      expect(prisma.booking.create).not.toHaveBeenCalled();
      expect(prisma.booking.update).not.toHaveBeenCalled();
    }
  );
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

  it("holds the booking at the request's lodge instead of the default lodge", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        lodgeId: "lodge-2",
        priceCents: 12000,
        quotes: [],
      }) as never
    );

    await holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" });

    // The default-lodge resolver must not run when the request names a lodge.
    expect(vi.mocked(prisma.lodge.findFirst)).not.toHaveBeenCalled();
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(bookingArgs.lodgeId).toBe("lodge-2");
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

  it("persists each guest's rate-membership-type snapshot on the held booking (#1930, E4)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({
        type: BookingRequestType.GENERAL,
        priceCents: 12000,
        quotes: [],
        guests: [
          { firstName: "Linked", lastName: "Member", ageTier: AgeTier.ADULT },
          { firstName: "Uma", lastName: "Unlinked", ageTier: AgeTier.ADULT },
        ],
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    // The admin-linked member carries a CUSTOM MEMBER_RATE type via its
    // seasonal assignment; its snapshot must record that type's id.
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "member-42",
        firstName: "Linked",
        lastName: "Member",
        email: "linked@example.test",
        role: "MEMBER",
        ageTier: AgeTier.ADULT,
      },
    ] as never);
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue([
      {
        memberId: "member-42",
        seasonYear: 2026,
        membershipType: {
          id: "type-club",
          key: "CLUB",
          name: "Club",
          isActive: true,
          isBuiltIn: false,
          bookingBehavior: "MEMBER_RATE",
          subscriptionBehavior: "REQUIRED",
        },
      },
    ] as never);

    await holdBookingRequestSlots({ requestId: "req-1", adminMemberId: "admin-1" });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    const created = (bookingArgs.guests as { create: Array<Record<string, unknown>> })
      .create;
    // Snapshot-only: the quoted per-guest price split is untouched.
    expect(created[0]).toMatchObject({
      memberId: "member-42",
      isMember: true,
      rateMembershipTypeId: "type-club",
      priceCents: 6000,
    });
    expect(created[1]).toMatchObject({
      isMember: false,
      rateMembershipTypeId: "type-nonmember",
      priceCents: 6000,
    });

    // Restore the suite defaults (clearAllMocks does not reset implementations).
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue([] as never);
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
        data: { heldBookingId: null, version: { increment: 1 } },
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

describe("quote context lodge presentation (ADR-002)", () => {
  function sentQuote(bookingRequestOverrides: Record<string, unknown>) {
    return {
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
      bookingRequest: baseRequest(bookingRequestOverrides),
    };
  }

  it("exposes the lodge name when the request names a lodge at a multi-lodge club", async () => {
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue(
      sentQuote({
        lodgeId: "lodge-2",
        lodge: { name: "Whakapapa Lodge" },
      }) as never
    );
    vi.mocked(prisma.lodge.count).mockResolvedValue(2 as never);

    const context = await getBookingRequestQuoteContext("a".repeat(64));

    expect(context.lodgeName).toBe("Whakapapa Lodge");
  });

  it("suppresses the lodge name for a single-lodge club", async () => {
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue(
      sentQuote({
        lodgeId: "lodge-2",
        lodge: { name: "Whakapapa Lodge" },
      }) as never
    );
    vi.mocked(prisma.lodge.count).mockResolvedValue(1 as never);

    const context = await getBookingRequestQuoteContext("a".repeat(64));

    expect(context.lodgeName).toBeNull();
  });

  it("returns a null lodge name for requests without an explicit lodge", async () => {
    vi.mocked(prisma.bookingRequestQuote.findUnique).mockResolvedValue(
      sentQuote({ lodgeId: null, lodge: null }) as never
    );

    const context = await getBookingRequestQuoteContext("a".repeat(64));

    expect(context.lodgeName).toBeNull();
    expect(vi.mocked(prisma.lodge.count)).not.toHaveBeenCalled();
  });
});

describe("findLinkedGuestMemberNightConflicts (advisory pre-check #1226)", () => {
  function overlappingGuestRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "existing-guest",
      memberId: "member-42",
      firstName: "Linked",
      lastName: "Member",
      stayStart: null,
      stayEnd: null,
      nights: [],
      member: { firstName: "Linked", lastName: "Member" },
      booking: {
        id: "existing-booking",
        memberId: "other-owner",
        status: BookingStatus.CONFIRMED,
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Other", lastName: "Owner" },
        guests: [{ id: "existing-guest", memberId: "member-42" }],
      },
      ...overrides,
    };
  }

  it("reports an overlap for a linked member without throwing (advisory only)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ guests: GUESTS, heldBookingId: null }) as never
    );
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([
      overlappingGuestRow(),
    ] as never);

    // The real findBookingMemberNightConflicts runs here; only the higher-level
    // assertNoBookingMemberNightConflicts assertion is spied elsewhere. The
    // advisory RESOLVES with the overlap rather than throwing — proving it does
    // not block linking the way the approve/hold guard's 409 does.
    const conflicts = await findLinkedGuestMemberNightConflicts({
      requestId: "req-1",
      adminMemberId: "admin-1",
      links: [{ guestIndex: 0, memberId: "member-42" }],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      memberId: "member-42",
      memberName: "Linked Member",
      bookingId: "existing-booking",
      bookingOwnerName: "Other Owner",
      conflictingNights: ["2026-08-01", "2026-08-02"],
    });
  });

  it("reports no conflict when the linked member is clear", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ guests: GUESTS, heldBookingId: null }) as never
    );
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);

    const conflicts = await findLinkedGuestMemberNightConflicts({
      requestId: "req-1",
      adminMemberId: "admin-1",
      links: [{ guestIndex: 0, memberId: "member-42" }],
    });

    expect(conflicts).toEqual([]);
  });

  it("excludes the request's own held booking so it never flags itself", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ guests: GUESTS, heldBookingId: "own-hold" }) as never
    );
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);

    await findLinkedGuestMemberNightConflicts({
      requestId: "req-1",
      adminMemberId: "admin-1",
      links: [{ guestIndex: 0, memberId: "member-42" }],
    });

    // The self-hold carries these same linked members on an AWAITING_REVIEW
    // booking (a conflict-eligible status), so the query MUST exclude it or the
    // advisory would report a false conflict against the request's own hold.
    const call = vi.mocked(prisma.bookingGuest.findMany).mock.calls[0][0] as {
      where: { booking: { id?: unknown } };
    };
    expect(call.where.booking.id).toEqual({ not: "own-hold" });
  });

  it("returns no conflict when there are no links and never queries", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(
      baseRequest({ guests: GUESTS, heldBookingId: null }) as never
    );

    const conflicts = await findLinkedGuestMemberNightConflicts({
      requestId: "req-1",
      adminMemberId: "admin-1",
      links: [],
    });

    expect(conflicts).toEqual([]);
    expect(prisma.bookingGuest.findMany).not.toHaveBeenCalled();
  });

  it("throws 404 for a missing request (an error the route renders, not a block)", async () => {
    vi.mocked(prisma.bookingRequest.findUnique).mockResolvedValue(null);

    await expect(
      findLinkedGuestMemberNightConflicts({
        requestId: "missing",
        adminMemberId: "admin-1",
        links: [{ guestIndex: 0, memberId: "member-42" }],
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
