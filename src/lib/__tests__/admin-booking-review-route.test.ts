import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  cancelBooking: vi.fn(),
  sendApprovedEmail: vi.fn(),
  sendRejectedEmail: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      updateMany: mocks.bookingUpdateMany,
    },
  },
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: mocks.cancelBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingReviewApprovedEmail: mocks.sendApprovedEmail,
  sendBookingReviewRejectedEmail: mocks.sendRejectedEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { PATCH } from "@/app/api/admin/bookings/[id]/review/route";

function makeRequest(body: unknown) {
  return new NextRequest("https://example.test/api/admin/bookings/b1/review", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminSession = {
  ok: true as const,
  session: { user: { id: "admin1", role: "ADMIN" } },
};

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(adminSession);
  mocks.sendApprovedEmail.mockResolvedValue(undefined);
  mocks.sendRejectedEmail.mockResolvedValue(undefined);
});

describe("PATCH /api/admin/bookings/[id]/review", () => {
  it("rejects requests missing adminNotes", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    const res = await PATCH(makeRequest({ status: "APPROVED", adminNotes: "" }), { params });
    expect(res.status).toBe(400);
  });

  it("409s when booking is not pending review", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "APPROVED",
      status: "PAYMENT_PENDING",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "ok" }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("approves: transitions to PAYMENT_PENDING and emails member", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });

    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "Approved on the condition that..." }),
      { params },
    );
    expect(res.status).toBe(200);

    const updateArgs = mocks.bookingUpdateMany.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
    });
    expect(updateArgs.data).toMatchObject({
      adminReviewStatus: "APPROVED",
      status: "PAYMENT_PENDING",
      adminReviewedById: "admin1",
    });

    expect(mocks.sendApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "member@example.com",
        bookingId: "b1",
        adminNotes: "Approved on the condition that...",
      }),
    );
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects: records decision, cancels booking, sends rejection email", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "member@example.com", firstName: "Alex" },
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.cancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true, refundAmountCents: 0, refundPercentage: 0, refundMethod: "card" },
    });

    const res = await PATCH(
      makeRequest({ status: "REJECTED", adminNotes: "Need an adult on the booking — sorry." }),
      { params },
    );
    expect(res.status).toBe(200);

    expect(mocks.bookingUpdateMany.mock.calls[0][0].data).toMatchObject({
      adminReviewStatus: "REJECTED",
      adminReviewNotes: "Need an adult on the booking — sorry.",
    });
    expect(mocks.cancelBooking).toHaveBeenCalledWith(
      "b1",
      "admin1",
      "ADMIN",
      expect.any(String),
      "card",
    );
    expect(mocks.sendRejectedEmail).toHaveBeenCalled();
  });

  it("returns 409 if another admin already claimed the review (race)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "b1",
      memberId: "m1",
      adminReviewStatus: "PENDING",
      status: "AWAITING_REVIEW",
      member: { email: "a@b.co", firstName: "A" },
      checkIn: new Date(),
      checkOut: new Date(),
    });
    mocks.bookingUpdateMany.mockResolvedValue({ count: 0 });

    const res = await PATCH(
      makeRequest({ status: "APPROVED", adminNotes: "noted" }),
      { params },
    );
    expect(res.status).toBe(409);
  });
});
