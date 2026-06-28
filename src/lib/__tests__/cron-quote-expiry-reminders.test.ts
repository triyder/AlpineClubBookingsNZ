import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingRequestType } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prismaMock: {
    bookingRequestQuote: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockGetSettings: vi.fn(),
  mockSendEmail: vi.fn(),
  mockIssueToken: vi.fn(),
  mockParseOptions: vi.fn(),
  mockParseGuests: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prismaMock }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockIssueToken.mockReturnValue({ token: "raw-token", tokenHash: "hash-token" });
  mocks.mockParseOptions.mockReturnValue([{ label: "Quote", totalCents: 1000 }]);
  mocks.mockParseGuests.mockReturnValue([{}, {}]);
});

describe("sendQuoteExpiryReminders", () => {
  it("does nothing when reminders are disabled (leadDays = 0)", async () => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 0,
    });

    const result = await sendQuoteExpiryReminders();

    expect(result).toEqual({ remindedCount: 0, failedCount: 0 });
    expect(prisma.bookingRequestQuote.findMany).not.toHaveBeenCalled();
  });

  it("rotates the token, emails a reminder, and stamps reminderSentAt", async () => {
    mocks.mockGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
    });
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.bookingRequestQuote.findMany).mockResolvedValue([
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
    ] as never);
    vi.mocked(prisma.bookingRequestQuote.update).mockResolvedValue({} as never);

    const result = await sendQuoteExpiryReminders();

    expect(result.remindedCount).toBe(1);
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
