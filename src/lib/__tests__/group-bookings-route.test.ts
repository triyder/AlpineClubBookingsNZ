import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GroupBookingPaymentMode, GroupBookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  applyRateLimit: vi.fn().mockReturnValue(null),
  createGroupBooking: vi.fn(),
  resolveGroupBookingByCode: vi.fn(),
  closeGroupBooking: vi.fn(),
  reopenGroupBooking: vi.fn(),
  joinGroupBookingAsMember: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: {
    groupBookingCreate: {},
    groupBookingLookup: {},
    groupBookingJoin: {},
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// The route imports the service; mock it so these are pure wiring tests.
vi.mock("@/lib/group-booking", async () => {
  const actual = await vi.importActual<typeof import("@/lib/group-booking")>(
    "@/lib/group-booking"
  );
  return {
    ...actual,
    createGroupBooking: mocks.createGroupBooking,
    resolveGroupBookingByCode: mocks.resolveGroupBookingByCode,
    closeGroupBooking: mocks.closeGroupBooking,
    reopenGroupBooking: mocks.reopenGroupBooking,
    joinGroupBookingAsMember: mocks.joinGroupBookingAsMember,
  };
});

import { POST } from "@/app/api/group-bookings/route";
import { GET, PATCH } from "@/app/api/group-bookings/[code]/route";
import { POST as joinPOST } from "@/app/api/group-bookings/[code]/join/route";
import { GroupBookingError } from "@/lib/group-booking";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/group-bookings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyRateLimit.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
});

describe("POST /api/group-bookings", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      })
    );
    expect(res.status).toBe(401);
    expect(mocks.createGroupBooking).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment mode with 422", async () => {
    const res = await POST(
      postRequest({ organiserBookingId: "booking-1", paymentMode: "NOPE" })
    );
    expect(res.status).toBe(422);
    expect(mocks.createGroupBooking).not.toHaveBeenCalled();
  });

  it("creates a group and returns the join code", async () => {
    mocks.createGroupBooking.mockResolvedValueOnce({
      id: "group-1",
      joinCode: "ABCD2345",
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      status: GroupBookingStatus.OPEN,
      joinDeadline: null,
      maxJoiners: null,
    });
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
      })
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      id: "group-1",
      joinCode: "ABCD2345",
      paymentMode: GroupBookingPaymentMode.ORGANISER_PAYS,
    });
    expect(mocks.createGroupBooking).toHaveBeenCalledWith(
      expect.objectContaining({ organiserBookingId: "booking-1" }),
      "member-1"
    );
  });

  it("maps a GroupBookingError to its status code", async () => {
    mocks.createGroupBooking.mockRejectedValueOnce(
      new GroupBookingError("This booking already has a group", 409)
    );
    const res = await POST(
      postRequest({
        organiserBookingId: "booking-1",
        paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      })
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "This booking already has a group",
    });
  });
});

describe("GET /api/group-bookings/[code]", () => {
  it("returns 404 for an unknown code", async () => {
    mocks.resolveGroupBookingByCode.mockResolvedValueOnce(null);
    const res = await GET(
      new NextRequest("http://localhost/api/group-bookings/ZZZZ9999"),
      { params: Promise.resolve({ code: "ZZZZ9999" }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns the public-safe summary for a known code", async () => {
    mocks.resolveGroupBookingByCode.mockResolvedValueOnce({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserFirstName: "Andy",
      checkIn: new Date("2026-07-01T00:00:00Z"),
      checkOut: new Date("2026-07-03T00:00:00Z"),
      joinDeadline: null,
      isJoinable: true,
    });
    const res = await GET(
      new NextRequest("http://localhost/api/group-bookings/ABCD2345"),
      { params: Promise.resolve({ code: "ABCD2345" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "ABCD2345",
      organiserFirstName: "Andy",
      isJoinable: true,
    });
    // No internal ids leaked.
    expect(body).not.toHaveProperty("organiserMemberId");
  });
});

describe("PATCH /api/group-bookings/[code]", () => {
  function patchRequest(body: unknown) {
    return new NextRequest("http://localhost/api/group-bookings/ABCD2345", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("closes a group for its owner", async () => {
    mocks.closeGroupBooking.mockResolvedValueOnce({
      status: GroupBookingStatus.CLOSED,
    });
    const res = await PATCH(patchRequest({ action: "close" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: GroupBookingStatus.CLOSED,
    });
    expect(mocks.closeGroupBooking).toHaveBeenCalledWith("ABCD2345", "member-1");
  });

  it("returns 403 when a non-owner tries to manage", async () => {
    mocks.reopenGroupBooking.mockRejectedValueOnce(
      new GroupBookingError("This is not your group booking", 403)
    );
    const res = await PATCH(patchRequest({ action: "reopen" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid action with 422", async () => {
    const res = await PATCH(patchRequest({ action: "delete" }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(422);
    expect(mocks.closeGroupBooking).not.toHaveBeenCalled();
    expect(mocks.reopenGroupBooking).not.toHaveBeenCalled();
  });
});

describe("POST /api/group-bookings/[code]/join", () => {
  function joinRequest(body: unknown) {
    return new NextRequest("http://localhost/api/group-bookings/ABCD2345/join", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }
  const validBody = {
    guests: [
      { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
    ],
  };

  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(401);
    expect(mocks.joinGroupBookingAsMember).not.toHaveBeenCalled();
  });

  it("rejects an empty guest list with 422", async () => {
    const res = await joinPOST(joinRequest({ guests: [] }), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(422);
    expect(mocks.joinGroupBookingAsMember).not.toHaveBeenCalled();
  });

  it("joins and returns the created booking", async () => {
    mocks.joinGroupBookingAsMember.mockResolvedValueOnce({
      bookingId: "booking-9",
      status: "PAYMENT_PENDING",
      isZeroDollarConfirmed: false,
      finalPriceCents: 4500,
      requiresPayment: true,
    });
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      bookingId: "booking-9",
      requiresPayment: true,
    });
    expect(mocks.joinGroupBookingAsMember).toHaveBeenCalledWith(
      { code: "ABCD2345", guests: validBody.guests },
      "member-1",
      "MEMBER"
    );
  });

  it("maps a capacity-exceeded error to 409 with its code and details", async () => {
    mocks.joinGroupBookingAsMember.mockRejectedValueOnce(
      new GroupBookingError("The lodge is full for these dates", 409, {
        code: "CAPACITY_EXCEEDED",
        details: { fullNights: ["2026-07-01"] },
      })
    );
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CAPACITY_EXCEEDED",
      details: { fullNights: ["2026-07-01"] },
    });
  });

  it("maps an organiser-pays group to 409 (not yet supported)", async () => {
    mocks.joinGroupBookingAsMember.mockRejectedValueOnce(
      new GroupBookingError(
        "Joining an organiser-pays group is not available yet",
        409
      )
    );
    const res = await joinPOST(joinRequest(validBody), {
      params: Promise.resolve({ code: "ABCD2345" }),
    });
    expect(res.status).toBe(409);
  });
});
