import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route coverage for the admin exclusive whole-lodge hold (issue #121, ADR-001):
// POST /api/admin/bookings/[id]/exclusive-hold. Mirrors the admin-capacity-hold
// route harness (its closest sibling admin capacity action), but the exclusive
// hold has NO empty-lodge precondition and runs NO capacity engine (decision 1):
// setting it is allowed regardless of existing overlapping bookings.
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
    findOverlappingCapacityHoldingBookings: vi.fn(),
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

// The route must NOT touch the capacity engine. These mocks exist only to fail
// loudly (via the assertions below) if a capacity call were ever introduced.
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  // Read-only conflict surfacing (issue #119) — NOT the capacity engine.
  findOverlappingCapacityHoldingBookings:
    mocks.findOverlappingCapacityHoldingBookings,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

import { POST } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";

function holdRequest(body: Record<string, unknown> = {}) {
  return new NextRequest(
    "http://localhost/api/admin/bookings/booking-1/exclusive-hold",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-1",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "vitest",
      },
      body: JSON.stringify(body),
    },
  );
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "CONFIRMED",
    deletedAt: null,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    wholeLodgeHoldByMemberId: null,
    ...overrides,
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
  mocks.tx.booking.findUnique.mockResolvedValue(booking());
  mocks.tx.booking.update.mockResolvedValue({
    wholeLodgeHold: true,
    wholeLodgeHoldAt: new Date("2026-07-14T00:00:00.000Z"),
  });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue([]);
});

describe("POST /api/admin/bookings/[id]/exclusive-hold", () => {
  it("sets the hold (200), stamps who/when, and writes the audit row", async () => {
    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, wholeLodgeHold: true });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          wholeLodgeHold: true,
          wholeLodgeHoldAt: expect.any(Date),
          wholeLodgeHoldByMemberId: "admin-1",
        }),
      }),
    );
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.exclusiveHold.set",
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityType: "Booking",
      entityId: "booking-1",
      category: "booking",
      outcome: "success",
    });
  });

  it("sets the hold even when other bookings overlap: no capacity engine call, no 409 (decision 1)", async () => {
    const response = await POST(holdRequest({ hold: true }), routeParams());

    expect(response.status).toBe(200);
    // The whole point of decision 1: setting is allowed over conflicts. The
    // route must never consult the capacity engine.
    expect(mocks.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    expect(mocks.acquireLodgeCapacityLock).not.toHaveBeenCalled();
    expect(mocks.tx.booking.update).toHaveBeenCalledTimes(1);
  });

  it("surfaces overlapping conflicts on set without refusing (issue #119): still 200, conflicts returned", async () => {
    const conflicts = [
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-09-01",
        checkOut: "2026-09-02",
        guestCount: 3,
        status: "CONFIRMED",
      },
    ];
    mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue(conflicts);

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.conflicts).toEqual(conflicts);
    // Called with the held booking's own id excluded, at its lodge/nights.
    expect(mocks.findOverlappingCapacityHoldingBookings).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        lodgeId: "lodge-1",
        excludeBookingId: "booking-1",
      }),
    );
    // Decision 1: the set still succeeded even with conflicts present.
    expect(mocks.tx.booking.update).toHaveBeenCalledTimes(1);
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toMatchObject({ overlappingConflictCount: 1 });
  });

  it("does not query conflicts when clearing the hold (nothing to surface)", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ wholeLodgeHold: true }),
    );
    mocks.tx.booking.update.mockResolvedValue({
      wholeLodgeHold: false,
      wholeLodgeHoldAt: null,
    });

    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conflicts).toEqual([]);
    expect(mocks.findOverlappingCapacityHoldingBookings).not.toHaveBeenCalled();
  });

  it("clears the hold (200), nulls the who/when fields, and audits the clear", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({
        wholeLodgeHold: true,
        wholeLodgeHoldAt: new Date("2026-07-10T00:00:00.000Z"),
        wholeLodgeHoldByMemberId: "admin-2",
      }),
    );
    mocks.tx.booking.update.mockResolvedValue({
      wholeLodgeHold: false,
      wholeLodgeHoldAt: null,
    });

    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, wholeLodgeHold: false });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: {
          wholeLodgeHold: false,
          wholeLodgeHoldAt: null,
          wholeLodgeHoldByMemberId: null,
        },
      }),
    );
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.exclusiveHold.cleared",
      actorMemberId: "admin-1",
      entityId: "booking-1",
    });
  });

  it("rejects a double set with 409 and no write", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ wholeLodgeHold: true }),
    );

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/already has an exclusive/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects clearing a booking with no hold (409, no write)", async () => {
    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/no exclusive whole-lodge hold to clear/i);
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
  });

  it("422s an invalid body (missing hold)", async () => {
    const response = await POST(holdRequest({}), routeParams());
    expect(response.status).toBe(422);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("404s a missing or soft-deleted booking", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);
    expect((await POST(holdRequest({ hold: true }), routeParams())).status).toBe(
      404,
    );

    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ deletedAt: new Date() }),
    );
    expect((await POST(holdRequest({ hold: true }), routeParams())).status).toBe(
      404,
    );
  });

  it("403s a non-admin caller without touching the booking", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await POST(holdRequest({ hold: true }), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
