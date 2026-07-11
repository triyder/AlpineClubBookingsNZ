import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level threading for the membership-cancellation review notify choice
// (#1787, mirroring #1705/#1769a): the route is admin-only by construction
// (requireAdmin), so it carries no extra actor gate — it just threads an
// optional notifyMember flag into the service, defaulting to notify when the
// flag is absent, and 400s a non-boolean via the existing schema parse.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  review: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/membership-cancellation-admin", () => ({
  reviewMembershipCancellationParticipant: h.review,
  MembershipCancellationAdminError: class MembershipCancellationAdminError extends Error {
    statusCode: number;
    details?: Record<string, unknown>;
    constructor(
      message: string,
      statusCode = 400,
      details?: Record<string, unknown>,
    ) {
      super(message);
      this.statusCode = statusCode;
      this.details = details;
    }
  },
}));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/route";

function req(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-cancellation-requests/req-1/participants/p-1",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const params = Promise.resolve({ requestId: "req-1", participantId: "p-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.review.mockResolvedValue({ request: { id: "req-1" } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST membership-cancellation participant review notify choice (#1787)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await POST(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(h.review.mock.calls[0][0].notifyMember).toBeUndefined();
  });

  it("threads notifyMember: false through to the service", async () => {
    const res = await POST(req({ action: "approve", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.review).toHaveBeenCalledWith(
      expect.objectContaining({ notifyMember: false }),
    );
  });

  it("threads notifyMember: true through to the service", async () => {
    const res = await POST(req({ action: "reject", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.review).toHaveBeenCalledWith(
      expect.objectContaining({ notifyMember: true }),
    );
  });

  it("rejects a non-boolean notifyMember with 400, no service call", async () => {
    const res = await POST(req({ action: "approve", notifyMember: "false" }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(h.review).not.toHaveBeenCalled();
  });
});
