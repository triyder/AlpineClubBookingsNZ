import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part A: a locked-period change request must name a structured change.
 * A note on its own (the free-text "Admin Request" an in-progress stay used to
 * send) is refused; a request naming the guests it adds, with their nights
 * inside the stay, is accepted.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
  memberFindMany: vi.fn(),
  logAudit: vi.fn(),
  sendAdminBookingChangeRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    // The owner's dependants, read by the dependant-identity rule (#4030 review M4).
    member: { findMany: (...args: unknown[]) => mocks.memberFindMany(...args) },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimiters: { bookingChangeRequest: { id: "booking-change-request" } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminBookingChangeRequestAlert(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  // The club's day for this suite: the stay below is under way.
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));

import { POST } from "@/app/api/bookings/[id]/change-requests/route";
import {
  CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE,
  CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE,
} from "@/lib/booking-change-request-guests";

function inProgressBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: new Date("2026-06-30T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: new Date("2026-06-30T00:00:00.000Z"),
        stayEnd: new Date("2026-07-03T00:00:00.000Z"),
      },
    ],
    member: { id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.com" },
    organisation: null,
    payment: null,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/change-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

const grandchild = (firstName: string, nights: { stayStart?: string; stayEnd?: string } = {}) => ({
  firstName,
  lastName: "Example",
  ageTier: "CHILD",
  isMember: false,
  ...nights,
});

describe("POST /api/bookings/[id]/change-requests — a structured change is required (#4030)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    mocks.bookingFindUnique.mockResolvedValue(inProgressBooking());
    mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.bookingChangeRequestCreate.mockImplementation(async (args: { data: unknown }) => ({
      id: "request-1",
      status: "REQUESTED",
      ...(args.data as object),
    }));
    mocks.sendAdminBookingChangeRequestAlert.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("refuses the free-text request the old card sent: an effective date and a note", async () => {
    const response = await post({
      requestedEffectiveDate: "2026-06-30",
      reason: "Can we add these three grandchildren to our booking",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("STRUCTURED_CHANGE_REQUIRED");
    expect(body.error).toBe(CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminBookingChangeRequestAlert).not.toHaveBeenCalled();
  });

  it("refuses a note with nothing else", async () => {
    const response = await post({ reason: "Please add my grandchildren" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("accepts a request naming the guests it adds, from a locked night, with the note kept", async () => {
    const response = await post({
      addGuests: [
        grandchild("Ari", { stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
        grandchild("Bo", { stayStart: "2026-07-01", stayEnd: "2026-07-03" }),
      ],
      reason: "They arrived with us.",
    });
    expect(response.status).toBe(201);
    const { data } = mocks.bookingChangeRequestCreate.mock.calls[0][0] as {
      data: { reason: string; requestedChanges: { requested: Record<string, unknown> } };
    };
    expect(data.reason).toBe("They arrived with us.");
    expect(data.requestedChanges.requested).toMatchObject({
      addGuests: [
        expect.objectContaining({ firstName: "Ari", stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
        expect.objectContaining({ firstName: "Bo", stayStart: "2026-07-01", stayEnd: "2026-07-03" }),
      ],
      summary: "add Ari Example, Bo Example",
    });
  });

  it("reads a guest with no nights as staying the whole stay, which reaches back to a locked night", async () => {
    const response = await post({ addGuests: [grandchild("Ari")] });
    expect(response.status).toBe(201);
  });

  it("refuses a guest whose nights fall outside the stay", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-06-29", stayEnd: "2026-07-03" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/must fall within the stay \(2026-06-30 to 2026-07-03\)/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses a guest whose date out is not after their date in", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-07-01", stayEnd: "2026-07-01" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Date Out must be after Date In/);
  });

  it("sends a guest added only from tomorrow to the guest editor (not a locked-period change)", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-07-02", stayEnd: "2026-07-03" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/past-night changes that require admin review/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses a guest with only one of their two dates, by the canonical range rule (review M3)", async () => {
    const response = await post({ addGuests: [grandchild("Ari", { stayStart: "2026-06-30" })] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Date In and Date Out are both required/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("does not count a stay range that repeats the guest's own nights as a change (review M2)", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
  });

  it("does not count a stay range missing a bound as a change (review M2)", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", stayEnd: "2026-07-01" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
  });

  it("reads an existing guest's nights by the canonical range rule (re-review of 72c933ffc)", async () => {
    const refused = async (range: Record<string, unknown>) => {
      const response = await post({
        guestStayRanges: [{ guestId: "guest-1", ...range }],
        requestedEffectiveDate: "2026-06-30",
      });
      expect(response.status).toBe(400);
      return (await response.json()).error as string;
    };
    expect(await refused({ stayStart: "2026-07-02", stayEnd: "2026-07-01" })).toMatch(
      /Date Out must be after Date In/,
    );
    expect(await refused({ stayStart: "30/06/2026", stayEnd: "2026-07-01" })).toMatch(
      /must use yyyy-mm-dd format/,
    );
    // A one-bound range beside a real change is refused, not stored.
    const response = await post({
      addGuests: [grandchild("Ari")],
      guestStayRanges: [{ guestId: "guest-1", stayEnd: "2026-07-01" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Date In and Date Out are both required/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses a date move the guests' nights do not reach, which range mode would drop (round 7, F2)", async () => {
    // Beyond the nights, and inside them: either way the planner would set the
    // stay's dates from the nights and silently ignore the requested one.
    for (const checkIn of ["2026-06-28", "2026-07-01"]) {
      const response = await post({
        checkIn,
        guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    }
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses an in-progress check-out move plus a card guest, naming the two-request way forward (round 8)", async () => {
    // A stay in progress sends the new check-out with no existing-guest ranges,
    // but the added-guest card always sends its guest's nights, which switches
    // the planner to range mode; the member's editor can't set the others'.
    const response = await post({
      checkOut: "2026-07-02",
      addGuests: [grandchild("Ari", { stayStart: "2026-06-30", stayEnd: "2026-07-02" })],
    });
    expect(response.status).toBe(400);
    const error = (await response.json()).error as string;
    expect(error).toBe(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    expect(error).toMatch(/send the date change on its own and add the guests in a second request/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("accepts a date move the guests' nights reach, and one that names no nights (round 7, F2)", async () => {
    const reached = await post({
      checkIn: "2026-06-29",
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-29", stayEnd: "2026-07-03" }],
    });
    expect(reached.status, JSON.stringify(await reached.clone().json())).toBe(201);
    const datesOnly = await post({ checkIn: "2026-06-29" });
    expect(datesOnly.status).toBe(201);
  });

  it("still accepts a stay range that changes the guest's nights", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(201);
  });

  it("refuses a typed guest named like one of the owner's dependants (review M4, INV-GUEST-019)", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "dep-1", firstName: "Ari", lastName: "Example" }]);
    const response = await post({ addGuests: [grandchild("Ari")] });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/same name as one of your dependants/);
    // Both readings of the name are answered (re-review of 72c933ffc): the
    // dependant goes on the member path, a namesake comes off the request.
    expect(body.error).toMatch(/If it is your dependant, add them with their own button above/);
    expect(body.error).toMatch(/If it is a different person who shares the name, this request can't add them/);
    expect(body.code).toBe("DEPENDANT_IDENTITY_UNRESOLVED");
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("lets the same dependant through on the member path (their family button)", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "dep-1", firstName: "Ari", lastName: "Example" }]);
    const response = await post({
      addGuests: [{ ...grandchild("Ari"), isMember: true, memberId: "dep-1" }],
    });
    expect(response.status).toBe(201);
  });
});
