import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockChoreCreate = vi.fn();
const mockChoreFindMany = vi.fn();
const mockLodgeFindFirst = vi.fn();
const mockLodgeFindUnique = vi.fn();
const mockAuditCreate = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    choreTemplate: {
      create: mockChoreCreate,
      findMany: mockChoreFindMany,
    },
    lodge: {
      findFirst: mockLodgeFindFirst,
      findUnique: mockLodgeFindUnique,
    },
    auditLog: {
      create: mockAuditCreate,
    },
  },
}));

describe("POST /api/admin/chores", () => {
  let POST: typeof import("@/app/api/admin/chores/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockChoreCreate.mockResolvedValue({ id: "ct1" });
    mockLodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mockAuditCreate.mockResolvedValue({});
    const mod = await import("@/app/api/admin/chores/route");
    POST = mod.POST;
  });

  it("rejects SPECIFIC_DAYS chores with no selected weekdays", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.frequencyDaysOfWeek?.[0]).toContain(
      "at least one day"
    );
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });

  it("accepts SPECIFIC_DAYS chores when weekdays are provided", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
        lodgeId: "lodge-1",
      }),
    });
    // #1988: the create must leave a member-actor audit row so the
    // bootstrap-import six-signal probe (signal 6) detects hand-configured
    // chore templates.
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CHORE_TEMPLATE_CREATED",
        actorMemberId: "admin1",
        entityType: "ChoreTemplate",
      }),
    });
  });

  it("creates a chore at an explicitly requested active lodge", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });
  });

  it("rejects creating a chore at an unknown or inactive lodge", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({ name: "Sweep Deck", lodgeId: "lodge-2" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/chores", () => {
  let GET: typeof import("@/app/api/admin/chores/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockChoreFindMany.mockResolvedValue([]);
    const mod = await import("@/app/api/admin/chores/route");
    GET = mod.GET;
  });

  it("lists every template when no lodge filter is given", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/chores"));

    expect(res.status).toBe(200);
    expect(mockChoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined })
    );
  });

  it("filters templates strictly to a lodge", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const res = await GET(
      new NextRequest("http://localhost/api/admin/chores?lodgeId=lodge-2")
    );

    expect(res.status).toBe(200);
    expect(mockChoreFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      })
    );
  });

  it("rejects listing chores at an unknown or inactive lodge (Low 2)", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const res = await GET(
      new NextRequest("http://localhost/api/admin/chores?lodgeId=lodge-2")
    );

    expect(res.status).toBe(400);
    expect(mockChoreFindMany).not.toHaveBeenCalled();
  });
});
