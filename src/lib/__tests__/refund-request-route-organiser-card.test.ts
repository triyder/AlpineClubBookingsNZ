import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3956 round 3: a member's appeal on a booking the group organiser paid for by
 * card is refused as a WAIT, not as "nothing left", while the group
 * cancellation's own refund to that card is still being made.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  refundRequestFindFirst: vi.fn(),
  refundRequestCreate: vi.fn(),
  organiserCardAppealCeilingFor: vi.fn(),
  refundAppealHandedBackCents: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    refundRequest: {
      findFirst: (...args: unknown[]) => mocks.refundRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.refundRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendAdminRefundRequestAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/organiser-child-refund", () => ({
  organiserCardAppealCeilingFor: (...args: unknown[]) => mocks.organiserCardAppealCeilingFor(...args),
}));
vi.mock("@/lib/edit-refund-hand-back", () => ({
  refundAppealHandedBackCents: (...args: unknown[]) => mocks.refundAppealHandedBackCents(...args),
}));

import { POST } from "@/app/api/bookings/[id]/refund-request/route";

const PENDING_MESSAGE = "The group's cancellation refund is still being processed; you can appeal once it has been made.";

function appeal() {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/refund-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "The lodge closed early due to weather.", requestedAmountCents: 1_000 }),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

describe("POST /api/bookings/[id]/refund-request on a booking the group organiser paid for by card (#3956)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mocks.refundRequestFindFirst.mockResolvedValue(null);
    mocks.refundRequestCreate.mockResolvedValue({ id: "rr-1" });
    mocks.refundAppealHandedBackCents.mockResolvedValue(0);
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CANCELLED",
      organiserSettled: true,
      parentBookingId: "parent-1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      deletedAt: null,
      payment: { id: "pay-1", source: "STRIPE", amountCents: 9000, refundedAmountCents: 0, status: "SUCCEEDED" },
      member: { firstName: "Alex", lastName: "Example" },
    });
  });

  it("refuses with a temporary message while the group cancellation's refund is still being made, not 'nothing left'", async () => {
    mocks.organiserCardAppealCeilingFor.mockResolvedValue({ ceilingCents: 0, combinedRefundPending: true });

    const response = await appeal();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: PENDING_MESSAGE });
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });

  it("still says 'nothing left' when the ceiling is zero and no refund is pending", async () => {
    mocks.organiserCardAppealCeilingFor.mockResolvedValue({ ceilingCents: 0, combinedRefundPending: false });

    const response = await appeal();

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/nothing left to refund/);
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });

  it("creates the appeal within the organiser-card ceiling once the refund is made", async () => {
    mocks.organiserCardAppealCeilingFor.mockResolvedValue({ ceilingCents: 4_000, combinedRefundPending: false });

    const response = await appeal();

    expect(response.status).toBe(201);
    expect(mocks.refundRequestCreate).toHaveBeenCalledTimes(1);
  });
});
