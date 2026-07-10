import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  modifyBookingBatch: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: h.modifyBookingBatch,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify", {
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
  h.authorizationRole.mockReturnValue("ADMIN");
  h.modifyBookingBatch.mockResolvedValue({ ok: "batch" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/bookings/[id]/modify admin override gating (issue #1668)", () => {
  it("rejects override flags from a non-admin with 403 and calls no service", async () => {
    h.authorizationRole.mockReturnValue("USER");

    const res = await PUT(req({ adminOverride: true, pricingMode: "shift" }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("requires a pricingMode when adminOverride is set (400)", async () => {
    const res = await PUT(req({ adminOverride: true, checkIn: "2026-09-12" }), {
      params,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Choose a pricing mode for the admin override",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("rejects pricingMode without adminOverride (400)", async () => {
    const res = await PUT(req({ pricingMode: "shift", checkIn: "2026-09-12" }), {
      params,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error:
        "adminOverride is required for pricingMode/confirmOverCapacity/notifyMember",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("rejects notifyMember without adminOverride (400)", async () => {
    const res = await PUT(
      req({ notifyMember: false, checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("enforces the date-only contract (rejects guest inputs with 400)", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        removeGuestIds: ["g1"],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Admin override edits change dates only",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("dispatches a shift override to adminShiftBookingDates, not the batch service", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        notifyMember: false,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    const arg = h.adminShiftBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    // The admin's email choice is threaded to the service (owner decision).
    expect(arg.input).toMatchObject({
      checkIn: "2026-09-12",
      notifyMember: false,
    });
  });

  it("dispatches a recalculate override to the batch service", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-09-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("maps an unconfirmed over-capacity throw to a 409 with code + nightDetails", async () => {
    const nightDetails = [{ date: "2026-09-12", availableBeds: -1 }];
    h.adminShiftBookingDates.mockRejectedValue(
      new OverCapacityConfirmationRequiredError(nightDetails),
    );

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "OVER_CAPACITY_CONFIRM_REQUIRED",
      nightDetails,
    });
  });
});
