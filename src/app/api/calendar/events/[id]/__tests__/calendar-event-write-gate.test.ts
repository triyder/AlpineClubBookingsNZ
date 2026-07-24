import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

vi.mock("server-only", () => ({}));

// Drive requireActiveSession per-test: set the acting user's merged admin matrix
// (and their committee-membership flag) then assert the PATCH/DELETE gate.
const mocks = vi.hoisted(() => ({
  sessionUser: null as Record<string, unknown> | null,
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: vi.fn(async () =>
    mocks.sessionUser
      ? { ok: true, session: { user: mocks.sessionUser } }
      : { ok: false, response: new Response("unauth", { status: 401 }) },
  ),
}));

vi.mock("@/lib/calendar-service", () => ({
  updateCalendarEvent: mocks.updateCalendarEvent,
  deleteCalendarEvent: mocks.deleteCalendarEvent,
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { PATCH, DELETE } from "../route";

const lodgeEditMatrix: AdminPermissionMatrix = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "edit",
  content: "none",
  support: "none",
};

const noAccessMatrix: AdminPermissionMatrix = {
  ...lodgeEditMatrix,
  lodge: "none",
};

function committeeUser() {
  // A non-admin who holds an active committee assignment: create-only. The
  // edit/delete gate reads the admin matrix alone, so the committee flag is
  // irrelevant here — an all-none matrix must be denied.
  return { id: "committee-1", email: "c@example.com", adminPermissionMatrix: noAccessMatrix };
}

function adminUser() {
  return { id: "admin-1", email: "a@example.com", adminPermissionMatrix: lodgeEditMatrix };
}

const params = Promise.resolve({ id: "evt-1" });

function patchReq(body: unknown) {
  return new Request("http://localhost/api/calendar/events/evt-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteReq(scope = "series") {
  return new Request(
    `http://localhost/api/calendar/events/evt-1?scope=${scope}`,
    { method: "DELETE" },
  );
}

describe("calendar event PATCH/DELETE gate (committee is create-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionUser = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forbids a committee member from editing (PATCH → 403), service untouched", async () => {
    mocks.sessionUser = committeeUser();
    const res = await PATCH(patchReq({ title: "Hijacked" }) as never, {
      params,
    });
    expect(res.status).toBe(403);
    expect(mocks.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it("forbids a committee member from deleting a whole series (DELETE → 403), service untouched", async () => {
    mocks.sessionUser = committeeUser();
    const res = await DELETE(deleteReq("series") as never, { params });
    expect(res.status).toBe(403);
    expect(mocks.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("allows a lodge-edit admin to delete", async () => {
    mocks.sessionUser = adminUser();
    mocks.deleteCalendarEvent.mockResolvedValue({
      scope: "series",
      title: "Committee meeting",
      deletedCount: 12,
    });
    const res = await DELETE(deleteReq("series") as never, { params });
    expect(res.status).toBe(200);
    expect(mocks.deleteCalendarEvent).toHaveBeenCalledWith("evt-1", "series");
  });
});
