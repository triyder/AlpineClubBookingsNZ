import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/admin/member-lifecycle-action-requests widens the action enum to
// [ARCHIVE, DELETE] (default ARCHIVE for back-compat, #1938) and maps the
// deletion-requests page's PENDING status onto the lifecycle REQUESTED state at
// the query boundary. requireAdmin gating is unchanged.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminMemberLifecycleRequests: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/member-lifecycle-actions", () => ({
  getAdminMemberLifecycleRequests: h.getAdminMemberLifecycleRequests,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "@/app/api/admin/member-lifecycle-action-requests/route";

function req(query: string) {
  return new NextRequest(
    `http://localhost/api/admin/member-lifecycle-action-requests${query}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.getAdminMemberLifecycleRequests.mockResolvedValue({
    requests: [],
    pendingCount: 0,
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 0,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET member-lifecycle-action-requests (#1938)", () => {
  it("defaults to ARCHIVE + REQUESTED for back-compat when no query is given", async () => {
    const res = await GET(req(""));

    expect(res.status).toBe(200);
    expect(h.getAdminMemberLifecycleRequests).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ARCHIVE", status: "REQUESTED" }),
    );
  });

  it("passes action=DELETE through", async () => {
    const res = await GET(req("?action=DELETE"));

    expect(res.status).toBe(200);
    expect(h.getAdminMemberLifecycleRequests).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE" }),
    );
  });

  it("maps the deletion-requests page status PENDING onto REQUESTED", async () => {
    const res = await GET(req("?action=DELETE&status=PENDING"));

    expect(res.status).toBe(200);
    expect(h.getAdminMemberLifecycleRequests).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DELETE", status: "REQUESTED" }),
    );
  });

  it("preserves APPROVED / REJECTED / ALL statuses unchanged", async () => {
    for (const status of ["APPROVED", "REJECTED", "ALL"]) {
      h.getAdminMemberLifecycleRequests.mockClear();
      const res = await GET(req(`?action=DELETE&status=${status}`));
      expect(res.status).toBe(200);
      expect(h.getAdminMemberLifecycleRequests).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    }
  });

  it("rejects an unknown action with 400 and does not query", async () => {
    const res = await GET(req("?action=PURGE"));

    expect(res.status).toBe(400);
    expect(h.getAdminMemberLifecycleRequests).not.toHaveBeenCalled();
  });

  it("returns 403 response from requireAdmin without querying", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    });

    const res = await GET(req("?action=DELETE"));

    expect(res.status).toBe(403);
    expect(h.getAdminMemberLifecycleRequests).not.toHaveBeenCalled();
  });
});
