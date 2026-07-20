import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([]),
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    checkCapacityForGuestRanges: vi.fn(),
    requiresAdultSupervisionReview: vi.fn(),
    reconcileBedAllocationsForBooking: vi.fn(),
    sendBookingConfirmedEmail: vi.fn(),
    // Split-parent describe helper reads the provisional non-member child via
    // prisma.booking.findFirst; default null = not a split parent.
    prismaBookingFindFirst: vi.fn().mockResolvedValue(null),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: {
      findFirst: mocks.prismaBookingFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/booking-review", () => ({
  requiresAdultSupervisionReview: mocks.requiresAdultSupervisionReview,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocationsForBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendBookingConfirmedEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

import { POST } from "@/app/api/admin/bookings/[id]/force-confirm/route";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

function forceConfirmRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/bookings/booking-1/force-confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1",
      "x-forwarded-for": "203.0.113.5",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function waitlistBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "WAITLIST_OFFERED",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    finalPriceCents: 12000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    requiresAdminReview: false,
    adminReviewStatus: "APPROVED",
    adminReviewReason: null,
    waitlistPosition: null,
    waitlistOfferedAt: new Date("2026-06-01T00:00:00.000Z"),
    waitlistOfferExpiresAt: new Date("2026-06-03T00:00:00.000Z"),
    guests: [
      {
        id: "guest-1",
        isMember: true,
        nights: [],
      },
    ],
    member: {
      id: "member-1",
      email: "member@example.com",
      firstName: "Alex",
    },
    promoRedemption: null,
  };
}

function overbookedCapacity() {
  return {
    available: false,
    minAvailable: -1,
    nightDetails: [
      {
        date: new Date("2026-07-01T00:00:00.000Z"),
        occupiedBeds: 30,
        availableBeds: -1,
      },
      {
        date: new Date("2026-07-02T00:00:00.000Z"),
        occupiedBeds: 29,
        availableBeds: 0,
      },
    ],
  };
}

describe("POST /api/admin/bookings/[id]/force-confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
    mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());
    mocks.tx.booking.update.mockResolvedValue({});
    mocks.tx.auditLog.create.mockResolvedValue({});
    mocks.checkCapacityForGuestRanges.mockResolvedValue(overbookedCapacity());
    mocks.requiresAdultSupervisionReview.mockReturnValue(false);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  });

  it("reports overbook dates without committing when override is not explicit", async () => {
    const response = await POST(forceConfirmRequest({}), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-01"],
    });
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes critical overbook audit evidence in the force-confirm transaction", async () => {
    const response = await POST(
      forceConfirmRequest({ allowOverbook: true }),
      routeParams(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      auditAction: "waitlist.force_confirmed_overbook",
      overbooked: true,
      overbookDates: ["2026-07-01"],
      status: "PAYMENT_PENDING",
    });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          status: "PAYMENT_PENDING",
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "waitlist.force_confirmed_overbook",
        actorMemberId: "admin-1",
        memberId: "admin-1",
        subjectMemberId: "member-1",
        targetId: "booking-1",
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        severity: "critical",
        outcome: "success",
        retentionClass: "critical",
        incidentPreserved: true,
        requestId: "request-1",
        ipAddress: "203.0.113.5",
        userAgent: "vitest",
        metadata: expect.objectContaining({
          previousStatus: "WAITLIST_OFFERED",
          nextStatus: "PAYMENT_PENDING",
          allowOverbook: true,
          overbooked: true,
          overbookDates: ["2026-07-01"],
          overbookedNights: [{ date: "2026-07-01", availableBeds: -1 }],
          guestCount: 1,
          finalPriceCents: 12000,
          parkedForAdminReview: false,
        }),
      }),
    });
  });

  // #1771 — an overbook force-confirm stamps the persisted capacity override on
  // the booking (who + when), so every downstream payment-time re-check honours
  // it and never cancels the deliberately-admitted booking.
  it("stamps the persisted capacity override on an overbook force-confirm (#1771)", async () => {
    const response = await POST(
      forceConfirmRequest({ allowOverbook: true }),
      routeParams(),
    );

    expect(response.status).toBe(200);
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capacityOverriddenAt: expect.any(Date),
          capacityOverriddenByMemberId: "admin-1",
        }),
      }),
    );
  });

  it("does NOT stamp the capacity override when the force-confirm fits within capacity (#1771)", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      nightDetails: [],
    });

    const response = await POST(forceConfirmRequest({}), routeParams());

    expect(response.status).toBe(200);
    const updateData = mocks.tx.booking.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("capacityOverriddenAt");
    expect(updateData).not.toHaveProperty("capacityOverriddenByMemberId");
  });

  // ADR-001 decision 5 (issue #118): an exclusive whole-lodge hold on the
  // target nights is NOT bypassable — even with allowOverbook the force-confirm
  // is refused and nothing advances.
  describe("whole-lodge hold non-bypass (issue #118)", () => {
    function heldCapacity() {
      return {
        available: false,
        minAvailable: 0,
        nightDetails: [
          {
            date: new Date("2026-07-01T00:00:00.000Z"),
            occupiedBeds: 8,
            // Pinned to 0 (never negative), so it never shows in overbookDates.
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
          {
            date: new Date("2026-07-02T00:00:00.000Z"),
            occupiedBeds: 8,
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
        ],
      };
    }

    it("refuses with 409 WHOLE_LODGE_HOLD_BLOCKED even when allowOverbook is set, committing nothing", async () => {
      mocks.checkCapacityForGuestRanges.mockResolvedValue(heldCapacity());

      const response = await POST(
        forceConfirmRequest({ allowOverbook: true }),
        routeParams(),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
      expect(body.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
      expect(body.blockedNights).toEqual(["2026-07-01", "2026-07-02"]);
      // No booking advances onto a held night; no audit row is written.
      expect(mocks.tx.booking.update).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    });
  });

  // #1723 path 1 (owner decision B): a past-dated force-confirm that lands
  // PAYMENT_PENDING is allowed but flagged at creation — in the response and
  // in the audit trail — because it creates an unpaid finished stay. Stay
  // dates are derived from the real clock (the route compares against NZ
  // today), never hardcoded calendar dates that would rot.
  describe("unpaid finished stay flagging (#1723 path 1)", () => {
    function bookingWithStay(
      days: { checkIn: number; checkOut: number },
      overrides: Record<string, unknown> = {},
    ) {
      return {
        ...waitlistBooking(),
        checkIn: addDaysDateOnly(getTodayDateOnly(), days.checkIn),
        checkOut: addDaysDateOnly(getTodayDateOnly(), days.checkOut),
        ...overrides,
      };
    }

    beforeEach(() => {
      // These tests pin the finished-stay flag, not capacity: leave capacity
      // clear so no overbook override is involved.
      mocks.checkCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
    });

    it("flags a past-dated force-confirm that lands PAYMENT_PENDING", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -10, checkOut: -8 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        status: "PAYMENT_PENDING",
        unpaidFinishedStay: true,
      });
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          details: expect.stringContaining("created an unpaid finished stay"),
          metadata: expect.objectContaining({
            createdUnpaidFinishedStay: true,
            nextStatus: "PAYMENT_PENDING",
          }),
        }),
      });
    });

    it("treats a stay checking out today as already finished (matches the queue cutoff)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -2, checkOut: 0 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ unpaidFinishedStay: true });
    });

    it("does not flag a future-dated stay", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: 5, checkOut: 7 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "PAYMENT_PENDING",
        unpaidFinishedStay: false,
      });
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            createdUnpaidFinishedStay: false,
          }),
        }),
      });
    });

    it("does not flag a past-dated $0 force-confirm (lands PAID with no card obligation)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -10, checkOut: -8 }, { finalPriceCents: 0 }),
      );
      mocks.tx.payment.upsert.mockResolvedValue({});

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "PAID",
        unpaidFinishedStay: false,
      });
    });

    it("does not flag a past-dated stay parked for admin review", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay(
          { checkIn: -10, checkOut: -8 },
          { adminReviewStatus: "PENDING" },
        ),
      );
      mocks.requiresAdultSupervisionReview.mockReturnValue(true);

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "AWAITING_REVIEW",
        unpaidFinishedStay: false,
      });
    });
  });

  // #1769b (#1705 semantics): the admin's per-action member-email choice. The
  // confirmation email only sends when the force-confirm lands PAID (a $0 stay
  // with review resolved and capacity available), so that is the only outcome a
  // suppression is real — the audit records `notifyMember: false` only there.
  describe("member-email notify choice (#1769b)", () => {
    function zeroDollarBooking(overrides: Record<string, unknown> = {}) {
      return { ...waitlistBooking(), finalPriceCents: 0, ...overrides };
    }

    beforeEach(() => {
      mocks.checkCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mocks.tx.booking.findUnique.mockResolvedValue(zeroDollarBooking());
      mocks.tx.payment.upsert.mockResolvedValue({});
      mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
    });

    it("emails the member and records no notify field by default (lands PAID)", async () => {
      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("PAID");
      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("threads the provisional non-member child into the split-parent force-confirm confirmation email (#1942 FIX 4b)", async () => {
      const holdUntil = new Date("2026-06-25T00:00:00.000Z");
      mocks.prismaBookingFindFirst.mockResolvedValue({
        nonMemberHoldUntil: holdUntil,
        _count: { guests: 3 },
      });

      const response = await POST(forceConfirmRequest({}), routeParams());
      expect(response.status).toBe(200);

      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const options = mocks.sendBookingConfirmedEmail.mock.calls[0][6];
      expect(options).toMatchObject({
        provisionalGuests: { guestCount: 3, holdUntil },
      });
    });

    it("suppresses the email and records notifyMember:false when notifyMember is false", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: false }),
        routeParams(),
      );

      expect(response.status).toBe(200);
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).toMatchObject({ notifyMember: false });
    });

    it("emails and records no notify field when notifyMember is true", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: true }),
        routeParams(),
      );

      expect(response.status).toBe(200);
      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("rejects a non-boolean notifyMember with 400 and runs no transaction", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: "false" }),
        routeParams(),
      );

      expect(response.status).toBe(400);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
    });

    it("records NO notify field on a priced force-confirm that lands PAYMENT_PENDING even with notifyMember:false", async () => {
      // Priced booking never lands PAID, so no confirmation email is sent and a
      // suppression there is not real — the honesty rule records no field.
      mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());

      const response = await POST(
        forceConfirmRequest({ notifyMember: false }),
        routeParams(),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("PAYMENT_PENDING");
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });
  });
});
