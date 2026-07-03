import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestFindMany: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdate: vi.fn(),
  requestCount: vi.fn(),
  guestUpdate: vi.fn(),
  transaction: vi.fn(),
  sendConfirmationEmail: vi.fn(),
  getSettings: vi.fn(),
  logAudit: vi.fn(),
  issueActionToken: vi.fn(),
  hashActionToken: vi.fn(),
}));

const txClient = {
  bookingGuest: { update: mocks.guestUpdate },
  bookingRequest: { update: mocks.requestUpdate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findMany: mocks.requestFindMany,
      findUnique: mocks.requestFindUnique,
      update: mocks.requestUpdate,
      count: mocks.requestCount,
    },
    $transaction: (cb: (tx: typeof txClient) => Promise<unknown>) =>
      mocks.transaction(cb),
  },
}));

vi.mock("@/lib/email", () => ({
  sendSchoolAttendeeConfirmationEmail: mocks.sendConfirmationEmail,
}));

vi.mock("@/lib/booking-request", () => ({
  getBookingRequestSettings: mocks.getSettings,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: mocks.issueActionToken,
  hashActionToken: mocks.hashActionToken,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  applySchoolAttendeeConfirmation,
  countUnconfirmedSchoolAttendeeLists,
  getSchoolAttendeeConfirmation,
  resendSchoolAttendeeConfirmation,
  SchoolAttendeeConfirmationError,
  sendSchoolAttendeeConfirmationPrompts,
} from "@/lib/school-attendee-confirmation";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_IN = new Date(NOW.getTime() + 10 * DAY_MS);

function schoolRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: "SCHOOL",
    contactFirstName: "Tina",
    contactLastName: "Teacher",
    contactEmail: "teacher@school.example",
    schoolName: "Ruapehu Primary",
    attendeesConfirmedAt: null,
    attendeeConfirmationTokenHash: null,
    attendeeConfirmationTokenExpiresAt: null,
    attendeeConfirmationLastSentAt: null,
    convertedBookingId: "booking-1",
    convertedBooking: {
      id: "booking-1",
      status: "CONFIRMED",
      deletedAt: null,
      checkIn: CHECK_IN,
      checkOut: new Date(CHECK_IN.getTime() + 2 * DAY_MS),
      finalPriceCents: 90000,
      payment: null,
      guests: [
        {
          id: "g1",
          firstName: "School Child 1",
          lastName: "Placeholder",
          ageTier: "CHILD",
          isMember: false,
          memberId: null,
        },
        {
          id: "g2",
          firstName: "Terry",
          lastName: "Teacher",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m-teacher",
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  });
  mocks.issueActionToken.mockReturnValue({
    token: "raw-token",
    tokenHash: "hashed-token",
  });
  mocks.hashActionToken.mockImplementation((token: string) => `hash:${token}`);
  mocks.requestUpdate.mockResolvedValue({});
  mocks.guestUpdate.mockResolvedValue({});
  mocks.sendConfirmationEmail.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(
    async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
  );
});

describe("sendSchoolAttendeeConfirmationPrompts", () => {
  it("sends the first prompt with a rotated token valid until check-in", async () => {
    mocks.requestFindMany.mockResolvedValue([schoolRequest()]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0 });
    // Token rotated before the send; the link stays valid until check-in.
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
      },
    });
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "teacher@school.example",
        token: "raw-token",
        guestCount: 2,
        isReminder: false,
      }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeeConfirmationLastSentAt: NOW },
    });
  });

  it("re-prompts as a reminder once the cadence window has elapsed", async () => {
    mocks.requestFindMany.mockResolvedValue([
      schoolRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 3 * DAY_MS),
      }),
    ]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ isReminder: true }),
    );
  });

  it("is idempotent inside a cadence window: reruns send nothing", async () => {
    mocks.requestFindMany.mockResolvedValue([
      schoolRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 1 * DAY_MS),
      }),
    ]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0 });
    expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when the prompts are disabled (lead days 0)", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 0, sent: 0, failed: 0 });
    expect(mocks.requestFindMany).not.toHaveBeenCalled();
  });

  it("keeps lastSentAt unchanged when the email fails, so the next run retries", async () => {
    mocks.requestFindMany.mockResolvedValue([schoolRequest()]);
    mocks.sendConfirmationEmail.mockRejectedValueOnce(new Error("SES down"));

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1 });
    expect(mocks.requestUpdate).toHaveBeenCalledTimes(1); // token rotation only
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { attendeeConfirmationLastSentAt: NOW },
      }),
    );
  });
});

describe("getSchoolAttendeeConfirmation", () => {
  it("returns ready with the guest list for a live token", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
      }),
    );

    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);

    expect(mocks.requestFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendeeConfirmationTokenHash: "hash:raw-token" },
      }),
    );
    expect(details.status).toBe("ready");
    expect(details.booking?.guests).toHaveLength(2);
    expect(details.booking?.guests[1].isMember).toBe(true);
  });

  it("reports invalid for an unknown token", async () => {
    mocks.requestFindUnique.mockResolvedValue(null);
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("invalid");
  });

  it("reports confirmed once the school has confirmed", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("confirmed");
  });

  it("reports expired past the token expiry", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({
        attendeeConfirmationTokenExpiresAt: new Date(NOW.getTime() - 1),
      }),
    );
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("expired");
  });

  it("reports closed for a cancelled booking", async () => {
    const request = schoolRequest();
    (request.convertedBooking as { status: string }).status = "CANCELLED";
    mocks.requestFindUnique.mockResolvedValue(request);
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("closed");
  });
});

describe("applySchoolAttendeeConfirmation", () => {
  beforeEach(() => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeeConfirmationTokenExpiresAt: CHECK_IN }),
    );
  });

  it("renames placeholder attendees and records the explicit confirmation", async () => {
    const result = await applySchoolAttendeeConfirmation({
      token: "raw-token",
      guestUpdates: [
        { guestId: "g1", firstName: "Aroha", lastName: "Ngata" },
      ],
      confirm: true,
      now: NOW,
    });

    expect(result).toEqual({ confirmed: true, updatedGuestIds: ["g1"] });
    expect(mocks.guestUpdate).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { firstName: "Aroha", lastName: "Ngata" },
    });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeesConfirmedAt: NOW },
    });
  });

  it("saves names without confirming when confirm is not set", async () => {
    const result = await applySchoolAttendeeConfirmation({
      token: "raw-token",
      guestUpdates: [
        { guestId: "g1", firstName: "Aroha", lastName: "Ngata" },
      ],
      now: NOW,
    });

    expect(result.confirmed).toBe(false);
    expect(mocks.requestUpdate).not.toHaveBeenCalled();
  });

  it("rejects renaming a member guest", async () => {
    await expect(
      applySchoolAttendeeConfirmation({
        token: "raw-token",
        guestUpdates: [
          { guestId: "g2", firstName: "New", lastName: "Name" },
        ],
        now: NOW,
      }),
    ).rejects.toThrow(/Member guest names cannot be edited/);
    expect(mocks.guestUpdate).not.toHaveBeenCalled();
  });

  it("rejects an already-confirmed list", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    await expect(
      applySchoolAttendeeConfirmation({ token: "raw-token", confirm: true, now: NOW }),
    ).rejects.toBeInstanceOf(SchoolAttendeeConfirmationError);
  });
});

describe("countUnconfirmedSchoolAttendeeLists", () => {
  it("counts requests inside the lead window", async () => {
    mocks.requestCount.mockResolvedValue(2);
    await expect(countUnconfirmedSchoolAttendeeLists(NOW)).resolves.toBe(2);
  });

  it("returns zero when prompts are disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });
    await expect(countUnconfirmedSchoolAttendeeLists(NOW)).resolves.toBe(0);
    expect(mocks.requestCount).not.toHaveBeenCalled();
  });
});

describe("resendSchoolAttendeeConfirmation (#1153)", () => {
  it("rotates the token and sends immediately, valid until check-in", async () => {
    mocks.requestFindUnique.mockResolvedValue(schoolRequest());

    const result = await resendSchoolAttendeeConfirmation({
      bookingRequestId: "req-1",
      adminMemberId: "admin-1",
      now: NOW,
    });

    expect(result).toEqual({ sentTo: "teacher@school.example" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
      },
    });
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ token: "raw-token", isReminder: false }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeeConfirmationLastSentAt: NOW },
    });
  });

  it("uses a short expiry after check-in so late roster fixes stay possible", async () => {
    const request = schoolRequest();
    (request.convertedBooking as { checkIn: Date }).checkIn = new Date(
      NOW.getTime() - 1 * DAY_MS,
    );
    mocks.requestFindUnique.mockResolvedValue(request);

    await resendSchoolAttendeeConfirmation({
      bookingRequestId: "req-1",
      adminMemberId: "admin-1",
      now: NOW,
    });

    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: new Date(
          NOW.getTime() + 3 * DAY_MS,
        ),
      },
    });
  });

  it("refuses once the list is confirmed", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    await expect(
      resendSchoolAttendeeConfirmation({
        bookingRequestId: "req-1",
        adminMemberId: "admin-1",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SchoolAttendeeConfirmationError);
    expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("refuses non-school or unconverted requests", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ type: "GENERAL" }),
    );
    await expect(
      resendSchoolAttendeeConfirmation({
        bookingRequestId: "req-1",
        adminMemberId: "admin-1",
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
