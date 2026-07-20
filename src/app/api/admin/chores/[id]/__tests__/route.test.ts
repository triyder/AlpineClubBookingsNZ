import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    choreTemplate: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
    },
  },
}));

const mockCreateAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mockCreateAuditLog(...a),
}));

import { PUT, DELETE } from "@/app/api/admin/chores/[id]/route";

function okGuard(userId = "admin1") {
  return { ok: true as const, session: { user: { id: userId } } };
}
function forbiddenGuard() {
  return {
    ok: false as const,
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/chores/chore1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const params = Promise.resolve({ id: "chore1" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/admin/chores/[id] (#1988 audit coverage)", () => {
  it("writes a member-actor audit row with before/after on update", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard("admin1"));
    mockFindUnique.mockResolvedValue({
      id: "chore1",
      name: "Old",
      active: true,
      isEssential: false,
      lodgeId: "lodge1",
    });
    mockUpdate.mockResolvedValue({
      id: "chore1",
      name: "New",
      active: true,
      isEssential: false,
      lodgeId: "lodge1",
    });

    const res = await PUT(putReq({ name: "New" }), { params });
    expect(res.status).toBe(200);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHORE_TEMPLATE_UPDATED",
        actorMemberId: "admin1",
        entityType: "ChoreTemplate",
        entityId: "chore1",
        category: "admin",
        metadata: expect.objectContaining({
          before: expect.objectContaining({ name: "Old" }),
          after: expect.objectContaining({ name: "New" }),
        }),
      }),
    );
  });

  it("404s and does not audit when the chore is missing", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockFindUnique.mockResolvedValue(null);
    mockUpdate.mockRejectedValue(new Error("Record not found"));

    const res = await PUT(putReq({ name: "New" }), { params });
    expect(res.status).toBe(404);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("403s and does not audit when forbidden", async () => {
    mockRequireAdmin.mockResolvedValue(forbiddenGuard());
    const res = await PUT(putReq({ name: "New" }), { params });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/chores/[id] (#1988 audit coverage)", () => {
  it("writes a member-actor audit row on delete", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard("admin1"));
    mockFindUnique.mockResolvedValue({
      id: "chore1",
      name: "Sweep",
      lodgeId: "lodge1",
    });
    mockDelete.mockResolvedValue({ id: "chore1" });

    const res = await DELETE(new NextRequest("http://localhost/api/admin/chores/chore1"), {
      params,
    });
    expect(res.status).toBe(200);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHORE_TEMPLATE_DELETED",
        actorMemberId: "admin1",
        entityType: "ChoreTemplate",
        entityId: "chore1",
        category: "admin",
      }),
    );
  });

  it("404s and does not audit when the chore is missing", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockFindUnique.mockResolvedValue(null);
    mockDelete.mockRejectedValue(new Error("Record not found"));

    const res = await DELETE(new NextRequest("http://localhost/api/admin/chores/chore1"), {
      params,
    });
    expect(res.status).toBe(404);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
