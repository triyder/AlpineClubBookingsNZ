import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  legacyRole: vi.fn(),
  managementRole: vi.fn(),
  modifyBookingDates: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/access-roles", () => ({
  authorizationRoleFromAccessRoles: h.legacyRole,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  modifyBookingDates: h.modifyBookingDates,
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify-dates/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-dates", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.legacyRole.mockReturnValue("USER");
  h.managementRole.mockReturnValue("ADMIN");
  h.modifyBookingDates.mockResolvedValue({ ok: "dates" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/bookings/[id]/modify-dates admin override gating (issue #1668)", () => {
  it("rejects override flags when the management role is not ADMIN (403), no service call", async () => {
    h.managementRole.mockReturnValue("USER");

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("dispatches a shift override to adminShiftBookingDates with the management role", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        confirmOverCapacity: true,
        notifyMember: false,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
    const arg = h.adminShiftBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    // The admin's email choice is threaded to the service (owner decision).
    expect(arg.input).toMatchObject({
      checkIn: "2026-09-12",
      confirmOverCapacity: true,
      notifyMember: false,
    });
  });

  it("dispatches a recalculate override to modifyBookingDates with the flags threaded", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-09-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    const arg = h.modifyBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.input).toMatchObject({
      adminOverride: true,
      checkIn: "2026-09-12",
    });
  });

  it("keeps the legacy role mapping for requests without override flags", async () => {
    const res = await PUT(req({ checkIn: "2026-09-12" }), { params });

    expect(res.status).toBe(200);
    expect(h.managementRole).not.toHaveBeenCalled();
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    const arg = h.modifyBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "USER" });
    expect(arg.input).not.toHaveProperty("adminOverride", true);
  });

  it("keeps the legacy role for adminOverride: false — a caller boolean cannot flip the standard path's authority", async () => {
    const res = await PUT(
      req({ adminOverride: false, checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    const arg = h.modifyBookingDates.mock.calls[0][0];
    // Management role is only consulted for the 403 gate; the service call
    // stays on the legacy mapping because the override is not active.
    expect(arg.actor).toEqual({ id: "u1", role: "USER" });
  });
});
