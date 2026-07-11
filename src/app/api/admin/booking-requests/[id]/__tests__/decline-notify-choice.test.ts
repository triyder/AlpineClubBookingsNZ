import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level threading for the per-decline requester-email choice (#1791,
// mirroring #1769a / #1705): an admin-only route (`requireAdmin`) accepts an
// optional `notifyMember` boolean — absent = notify (default), false =
// suppress, non-boolean = 400 — and threads it into `declineBookingRequest`.
// There is no extra actor gate and therefore no 403 case: `requireAdmin`
// already restricts the route to admins.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  declineBookingRequest: vi.fn(),
  serializeBookingRequestForAdmin: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/booking-request", () => ({
  // The route uses `err instanceof BookingRequestError`; a minimal class keeps
  // the import resolvable. Success-path tests never hit the catch branch.
  BookingRequestError: class BookingRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  declineBookingRequest: h.declineBookingRequest,
  serializeBookingRequestForAdmin: h.serializeBookingRequestForAdmin,
}));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));

import { POST } from "@/app/api/admin/booking-requests/[id]/decline/route";

function req(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/booking-requests/req-1/decline",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const params = Promise.resolve({ id: "req-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.declineBookingRequest.mockResolvedValue({ id: "req-1", status: "DECLINED" });
  h.serializeBookingRequestForAdmin.mockReturnValue({
    id: "req-1",
    status: "DECLINED",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/booking-requests/[id]/decline notify choice (#1791)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await POST(req({ reason: "Fully booked" }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0].notifyMember).toBeUndefined();
  });

  it("threads notifyMember: false to the service", async () => {
    const res = await POST(req({ notifyMember: false }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0]).toMatchObject({
      notifyMember: false,
    });
  });

  it("threads notifyMember: true to the service", async () => {
    const res = await POST(req({ notifyMember: true }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0]).toMatchObject({
      notifyMember: true,
    });
  });

  it("rejects a non-boolean notifyMember with 400 and never calls the service", async () => {
    const res = await POST(req({ notifyMember: "false" }), { params });

    expect(res.status).toBe(400);
    expect(h.declineBookingRequest).not.toHaveBeenCalled();
  });
});
