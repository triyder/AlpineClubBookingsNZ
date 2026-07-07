import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Multi-lodge phase 7 retrofit for the admin chore roster: the route must
// honour an explicit ?lodgeId=, reject unknown/inactive lodges, and keep
// falling back to the default lodge when the parameter is omitted.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  getAdminRosterForDate: vi.fn(),
  updateAdminRosterForDate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => {
    const session = await mocks.auth();
    if (!session?.user?.id) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      };
    }
    return { ok: true, session };
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
  },
}));

vi.mock("@/lib/admin-roster-service", () => ({
  getAdminRosterForDate: mocks.getAdminRosterForDate,
  updateAdminRosterForDate: mocks.updateAdminRosterForDate,
  rosterActionSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
}));

import { GET, PUT } from "@/app/api/admin/roster/[date]/route";

const dateParams = { params: Promise.resolve({ date: "2026-07-10" }) };

describe("admin roster lodge scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });
    mocks.getAdminRosterForDate.mockResolvedValue({ body: { ok: true }, init: undefined });
    mocks.updateAdminRosterForDate.mockResolvedValue({ body: { ok: true }, init: undefined });
  });

  it("falls back to the default lodge when no lodgeId is given", async () => {
    const req = new NextRequest("http://localhost/api/admin/roster/2026-07-10");
    const res = await GET(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.getAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-default" }),
    );
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("scopes the roster to an explicitly requested active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
    );
    const res = await GET(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.getAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
    );
    const res = await GET(req, dateParams);

    expect(res.status).toBe(400);
    expect(mocks.getAdminRosterForDate).not.toHaveBeenCalled();
  });

  it("scopes roster mutations to the requested lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest(
      "http://localhost/api/admin/roster/2026-07-10?lodgeId=lodge-2",
      {
        method: "PUT",
        body: JSON.stringify({ action: "confirm" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const res = await PUT(req, dateParams);

    expect(res.status).toBe(200);
    expect(mocks.updateAdminRosterForDate).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
  });
});
