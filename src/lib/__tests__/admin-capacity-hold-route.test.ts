import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route coverage for Admin Hold / Admin Unhold (#1764):
// POST/DELETE /api/admin/bookings/[id]/capacity-hold. Mirrors the
// admin-force-confirm-route harness — the closest sibling admin capacity
// action (advisory lock + capacity re-check + explicit overbook confirm).
const mocks = vi.hoisted(() => {
  const tx = {
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    acquireLodgeCapacityLock: vi.fn(),
    checkCapacityForGuestRanges: vi.fn(),
    getDefaultLodgeId: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
}));

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: mocks.getDefaultLodgeId,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

import {
  POST,
  DELETE,
} from "@/app/api/admin/bookings/[id]/capacity-hold/route";

function holdRequest(body: Record<string, unknown> = {}, method = "POST") {
  return new NextRequest(
    "http://localhost/api/admin/bookings/booking-1/capacity-hold",
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-1",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "vitest",
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    },
  );
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function paymentPendingBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAYMENT_PENDING",
    deletedAt: null,
    adminCapacityHoldAt: null,
    adminCapacityHoldByMemberId: null,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    originBookingRequest: null,
    guests: [{ id: "guest-1", nights: [] }],
    ...overrides,
  };
}

function availableCapacity() {
  return {
    available: true,
    minAvailable: 3,
    nightDetails: [
      {
        date: new Date("2026-09-01T00:00:00.000Z"),
        occupiedBeds: 2,
        availableBeds: 3,
      },
    ],
  };
}

function overbookedCapacity() {
  return {
    available: false,
    minAvailable: -1,
    nightDetails: [
      {
        date: new Date("2026-09-01T00:00:00.000Z"),
        occupiedBeds: 6,
        availableBeds: -1,
      },
      {
        date: new Date("2026-09-02T00:00:00.000Z"),
        occupiedBeds: 5,
        availableBeds: 0,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: {
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    },
  });
  mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
  mocks.tx.booking.findUnique.mockResolvedValue(paymentPendingBooking());
  mocks.tx.booking.update.mockResolvedValue({
    adminCapacityHoldAt: new Date("2026-07-11T00:00:00.000Z"),
  });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.checkCapacityForGuestRanges.mockResolvedValue(availableCapacity());
  mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
});

describe("POST /api/admin/bookings/[id]/capacity-hold (Admin Hold)", () => {
  it("holds a payment-pending booking and writes the audit row in-transaction", async () => {
    const response = await POST(holdRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, overbooked: false });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          adminCapacityHoldAt: expect.any(Date),
          adminCapacityHoldByMemberId: "admin-1",
        }),
      }),
    );
    // #1771: a within-capacity hold never persists the override columns.
    const holdUpdateData = mocks.tx.booking.update.mock.calls[0][0].data;
    expect(holdUpdateData).not.toHaveProperty("capacityOverriddenAt");
    expect(holdUpdateData).not.toHaveProperty("capacityOverriddenByMemberId");
    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.admin_capacity_hold.placed",
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityType: "Booking",
      entityId: "booking-1",
      category: "booking",
      outcome: "success",
    });
  });

  it("takes the lodge capacity lock BEFORE the capacity re-check (concurrent hold vs member booking race, #1366 pattern)", async () => {
    await POST(holdRequest(), routeParams());

    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      mocks.tx,
      "lodge-1",
    );
    expect(mocks.checkCapacityForGuestRanges).toHaveBeenCalledWith(
      "lodge-1",
      expect.any(Date),
      expect.any(Date),
      expect.anything(),
      "booking-1",
      mocks.tx,
    );
    const lockOrder =
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const capacityOrder =
      mocks.checkCapacityForGuestRanges.mock.invocationCallOrder[0];
    const updateOrder = mocks.tx.booking.update.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(capacityOrder);
    expect(capacityOrder).toBeLessThan(updateOrder);
  });

  it("a race loser re-reads under the lock and refuses when the booking left PAYMENT_PENDING", async () => {
    // First read (lock key) sees the stale row; the post-lock re-read finds a
    // concurrent transition landed (e.g. payment succeeded -> PAID).
    mocks.tx.booking.findUnique
      .mockResolvedValueOnce(paymentPendingBooking())
      .mockResolvedValueOnce(paymentPendingBooking({ status: "PAID" }));

    const response = await POST(holdRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/already holds capacity through its status/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires the explicit overbook confirm when the nights are full (409 CAPACITY_EXCEEDED)", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue(overbookedCapacity());

    const response = await POST(holdRequest({}), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-09-01"],
    });
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("holds over capacity with the explicit confirm and writes critical overbook audit evidence", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue(overbookedCapacity());

    const response = await POST(
      holdRequest({ allowOverbook: true }),
      routeParams(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      overbooked: true,
      overbookDates: ["2026-09-01"],
    });
    expect(mocks.tx.booking.update).toHaveBeenCalled();
    // #1771: an over-capacity hold also records the persisted override so a later
    // payment on this booking is never cancelled/bumped.
    const updateData = mocks.tx.booking.update.mock.calls[0][0].data;
    expect(updateData.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(updateData.capacityOverriddenByMemberId).toBe("admin-1");
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.admin_capacity_hold.placed_overbook",
      severity: "critical",
      incidentPreserved: true,
    });
  });

  it("rejects a booking that is not PAYMENT_PENDING (v1 scope)", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      paymentPendingBooking({ status: "PENDING" }),
    );

    const response = await POST(holdRequest(), routeParams());

    expect(response.status).toBe(400);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("rejects a booking that already holds capacity naturally", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      paymentPendingBooking({ status: "CONFIRMED" }),
    );

    const response = await POST(holdRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/already holds capacity/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("rejects a request-converted PENDING booking as already holding (#1254)", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      paymentPendingBooking({
        status: "PENDING",
        originBookingRequest: { id: "request-1" },
      }),
    );

    const response = await POST(holdRequest(), routeParams());

    expect(response.status).toBe(409);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("rejects a double hold", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      paymentPendingBooking({
        adminCapacityHoldAt: new Date("2026-07-10T00:00:00.000Z"),
        adminCapacityHoldByMemberId: "admin-2",
      }),
    );

    const response = await POST(holdRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/already has an admin capacity hold/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("404s a missing or soft-deleted booking", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);
    expect((await POST(holdRequest(), routeParams())).status).toBe(404);

    mocks.tx.booking.findUnique.mockResolvedValue(
      paymentPendingBooking({ deletedAt: new Date() }),
    );
    expect((await POST(holdRequest(), routeParams())).status).toBe(404);
  });

  it("403s a non-admin caller without touching the booking", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await POST(holdRequest(), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/bookings/[id]/capacity-hold (Admin Unhold)", () => {
  function heldBooking(overrides: Record<string, unknown> = {}) {
    return paymentPendingBooking({
      adminCapacityHoldAt: new Date("2026-07-10T00:00:00.000Z"),
      adminCapacityHoldByMemberId: "admin-2",
      ...overrides,
    });
  }

  it("releases the hold and writes the audit row", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(heldBooking());

    const response = await DELETE(holdRequest({}, "DELETE"), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: {
          adminCapacityHoldAt: null,
          adminCapacityHoldByMemberId: null,
        },
      }),
    );
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.admin_capacity_hold.released",
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityId: "booking-1",
    });
  });

  it("refuses once the booking holds capacity naturally (pay-while-held disables unhold)", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      heldBooking({ status: "PAID" }),
    );

    const response = await DELETE(holdRequest({}, "DELETE"), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/can no longer be released/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("answers a double-unhold with a clear 409 and no state change", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(paymentPendingBooking());

    const response = await DELETE(holdRequest({}, "DELETE"), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/no admin capacity hold/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("403s a non-admin caller", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await DELETE(holdRequest({}, "DELETE"), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
