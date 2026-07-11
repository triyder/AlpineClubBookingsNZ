import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level gating for the admin member-email choice on member-lifecycle
// review (#1788): `notifyMember` (absent = notify, false = suppress) is parsed
// on the existing schema and threaded into the service, which only honours it
// for ARCHIVE reviews. A non-boolean value fails the parse and returns 400.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  reviewMemberLifecycleActionRequest: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: h.getClientIp }));
vi.mock("@/lib/member-lifecycle-actions", () => ({
  reviewMemberLifecycleActionRequest: h.reviewMemberLifecycleActionRequest,
  // Real-enough stub for the route's `instanceof` branch (not exercised here).
  MemberLifecycleActionError: class MemberLifecycleActionError extends Error {},
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { PATCH } from "@/app/api/admin/member-lifecycle-action-requests/[requestId]/route";

function req(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/member-lifecycle-action-requests/r1",
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const params = Promise.resolve({ requestId: "r1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-2" } },
  });
  h.reviewMemberLifecycleActionRequest.mockResolvedValue({ request: { id: "r1" } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/admin/member-lifecycle-action-requests/[requestId] notify choice (#1788)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await PATCH(req({ action: "approve" }), { params });

    expect(res.status).toBe(200);
    const arg = h.reviewMemberLifecycleActionRequest.mock.calls[0][0];
    expect(arg.notifyMember).toBeUndefined();
  });

  it("threads notifyMember: false through to the service", async () => {
    const res = await PATCH(req({ action: "approve", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.reviewMemberLifecycleActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ notifyMember: false }),
    );
  });

  it("threads notifyMember: true through to the service", async () => {
    const res = await PATCH(req({ action: "reject", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.reviewMemberLifecycleActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ notifyMember: true }),
    );
  });

  it("rejects a non-boolean notifyMember with 400 and does not call the service", async () => {
    const res = await PATCH(req({ action: "approve", notifyMember: "false" }), {
      params,
    });

    expect(res.status).toBe(400);
    expect(h.reviewMemberLifecycleActionRequest).not.toHaveBeenCalled();
  });
});
