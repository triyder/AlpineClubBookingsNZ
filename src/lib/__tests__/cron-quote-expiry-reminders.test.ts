import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
} from "@prisma/client";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    bookingRequest: { findUnique: vi.fn(), update: vi.fn() },
    booking: { findUnique: vi.fn(), update: vi.fn() },
    bookingRequestQuote: { count: vi.fn() },
  };
  return {
    tx,
    prismaMock: {
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
      bookingRequest: {
        findMany: vi.fn(),
      },
      bookingRequestQuote: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
    mockReconcile: vi.fn(),
    mockGetSettings: vi.fn(),
    mockSendEmail: vi.fn(),
    mockIssueToken: vi.fn(),
    mockParseOptions: vi.fn(),
    mockParseGuests: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prismaMock }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...args: unknown[]) =>
    mocks.mockReconcile(...args),
}));
vi.mock("@/lib/booking-request", () => ({
  getBookingRequestSettings: (...args: unknown[]) => mocks.mockGetSettings(...args),
  parseBookingRequestGuests: (...args: unknown[]) => mocks.mockParseGuests(...args),
}));
vi.mock("@/lib/booking-request-quotes", () => ({
  parseBookingRequestQuoteOptions: (...args: unknown[]) =>
    mocks.mockParseOptions(...args),
}));
vi.mock("@/lib/email", () => ({
  sendBookingRequestQuoteEmail: (...args: unknown[]) => mocks.mockSendEmail(...args),
}));
vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: (...args: unknown[]) => mocks.mockIssueToken(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { sendQuoteExpiryReminders } from "@/lib/cron-quote-expiry-reminders";

// The one findMany mock serves both phases; discriminate by the where clause.
// Phase 1 (reminders) filters on `reminderSentAt: null`; phase 2 (hold release)
// does not (it filters on responseTokenExpiresAt <= now + a held booking).
function stubQuoteFindMany({
  reminderQuotes = [],
  releaseQuotes = [],
}: {
  reminderQuotes?: unknown[];
  releaseQuotes?: unknown[];
}) {
  vi.mocked(prisma.bookingRequestQuote.findMany).mockImplementation((async (args?: {
    where?: { reminderSentAt?: unknown };
  }) => {
    if (args?.where && "reminderSentAt" in args.where) {
      return reminderQuotes;
    }
    return releaseQuotes;
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockIssueToken.mockReturnValue({ token: "raw-token", tokenHash: "hash-token" });
  mocks.mockParseOptions.mockReturnValue([{ label: "Quote", totalCents: 1000 }]);
  mocks.mockParseGuests.mockReturnValue([{}, {}]);
  mocks.prismaMock.$transaction.mockImplementation(
    async (cb: (t: typeof mocks.tx) => unknown) => cb(mocks.tx),
  );
  stubQuoteFindMany({ reminderQuotes: [], releaseQuotes: [] });
  // Phase 3 (stale MODIFY/QUERY hold release, #1254) is a no-op by default.
  vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([] as never);
});

describe("sendQuoteExpiryReminders — reminders", () => {
  it("skips reminders when disabled (leadDays = 0) but still runs hold release", async () => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 0,
    });

    const result = await sendQuoteExpiryReminders();

    expect(result).toEqual({
      remindedCount: 0,
      failedCount: 0,
      releasedHoldCount: 0,
    });
    // Only the phase-2 (release) query runs; the reminder query is skipped.
    expect(prisma.bookingRequestQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.bookingRequestQuote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingRequest: { heldBookingId: { not: null } },
        }),
      }),
    );
  });

  it("rotates the token, emails a reminder, and stamps reminderSentAt", async () => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
    });
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    stubQuoteFindMany({
      reminderQuotes: [
        {
          id: "quote-1",
          bookingRequestId: "req-1",
          version: 1,
          options: [],
          message: null,
          responseTokenExpiresAt: expiresAt,
          bookingRequest: {
            id: "req-1",
            contactEmail: "tara@example.test",
            contactFirstName: "Tara",
            checkIn: new Date(),
            checkOut: new Date(),
            guests: [],
            type: BookingRequestType.GENERAL,
            schoolName: null,
          },
        },
      ],
    });
    vi.mocked(prisma.bookingRequestQuote.update).mockResolvedValue({} as never);

    const result = await sendQuoteExpiryReminders();

    expect(result.remindedCount).toBe(1);
    expect(result.releasedHoldCount).toBe(0);
    expect(prisma.bookingRequestQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "quote-1" },
        data: { responseTokenHash: "hash-token" },
      }),
    );
    expect(mocks.mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "raw-token",
        isReminder: true,
        email: "tara@example.test",
      }),
    );
    expect(prisma.bookingRequestQuote.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "quote-1" },
        data: expect.objectContaining({ reminderSentAt: expect.any(Date) }),
      }),
    );
  });
});

describe("sendQuoteExpiryReminders — expired hold release (issue #1254)", () => {
  beforeEach(() => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 0,
    });
  });

  it("cancels the AWAITING_REVIEW hold, frees the beds, and detaches heldBookingId", async () => {
    stubQuoteFindMany({
      releaseQuotes: [
        {
          id: "quote-9",
          version: 2,
          bookingRequestId: "req-9",
          bookingRequest: { heldBookingId: "held-9" },
        },
      ],
    });
    mocks.tx.bookingRequest.findUnique.mockResolvedValue({ heldBookingId: "held-9" });
    mocks.tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.AWAITING_REVIEW,
    });

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(1);
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "held-9" },
        data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
      }),
    );
    expect(mocks.mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "held-9" }),
    );
    expect(mocks.tx.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-9" },
        data: { heldBookingId: null },
      }),
    );
  });

  it("does NOT cancel a hold that was already accepted (now PENDING)", async () => {
    stubQuoteFindMany({
      releaseQuotes: [
        {
          id: "quote-10",
          version: 1,
          bookingRequestId: "req-10",
          bookingRequest: { heldBookingId: "held-10" },
        },
      ],
    });
    mocks.tx.bookingRequest.findUnique.mockResolvedValue({ heldBookingId: "held-10" });
    // Accepted quotes convert the held row to PENDING — must never be cancelled.
    mocks.tx.booking.findUnique.mockResolvedValue({ status: BookingStatus.PENDING });

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(0);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.bookingRequest.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the request no longer points at the hold (raced release)", async () => {
    stubQuoteFindMany({
      releaseQuotes: [
        {
          id: "quote-11",
          version: 1,
          bookingRequestId: "req-11",
          bookingRequest: { heldBookingId: "held-11" },
        },
      ],
    });
    mocks.tx.bookingRequest.findUnique.mockResolvedValue({ heldBookingId: null });

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(0);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });
});

describe("sendQuoteExpiryReminders — stale MODIFY/QUERY hold release (issue #1254)", () => {
  const past = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
  const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  beforeEach(() => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 0,
    });
  });

  it("releases the hold once the last quote window has lapsed and no quote is outstanding", async () => {
    vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([
      {
        id: "req-m",
        heldBookingId: "held-m",
        quotes: [{ responseTokenExpiresAt: past() }],
      },
    ] as never);
    mocks.tx.bookingRequest.findUnique.mockResolvedValue({
      heldBookingId: "held-m",
      status: BookingRequestStatus.MODIFICATION_REQUESTED,
    });
    mocks.tx.bookingRequestQuote.count.mockResolvedValue(0);
    mocks.tx.booking.findUnique.mockResolvedValue({
      status: BookingStatus.AWAITING_REVIEW,
    });

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(1);
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "held-m" },
        data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
      }),
    );
    expect(mocks.mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "held-m" }),
    );
    expect(mocks.tx.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "req-m" },
        data: { heldBookingId: null },
      }),
    );
  });

  it("does NOT release while the last quote window is still open", async () => {
    vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([
      {
        id: "req-m2",
        heldBookingId: "held-m2",
        quotes: [{ responseTokenExpiresAt: future() }],
      },
    ] as never);

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(0);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.bookingRequest.update).not.toHaveBeenCalled();
  });

  it("does NOT release when a fresh quote is outstanding by the time the lock is held", async () => {
    vi.mocked(prisma.bookingRequest.findMany).mockResolvedValue([
      {
        id: "req-m3",
        heldBookingId: "held-m3",
        quotes: [{ responseTokenExpiresAt: past() }],
      },
    ] as never);
    mocks.tx.bookingRequest.findUnique.mockResolvedValue({
      heldBookingId: "held-m3",
      status: BookingRequestStatus.QUERY_PENDING,
    });
    // An admin re-sent a quote between the scan and the lock.
    mocks.tx.bookingRequestQuote.count.mockResolvedValue(1);

    const result = await sendQuoteExpiryReminders();

    expect(result.releasedHoldCount).toBe(0);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.bookingRequest.update).not.toHaveBeenCalled();
  });
});
