import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  lodgeFindMany: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  lodgeCount: vi.fn(),
  lodgeCreate: vi.fn(),
  lodgeUpdate: vi.fn(),
  bookingCount: vi.fn(),
  hutLeaderAssignmentCount: vi.fn(),
  memberLodgeAccessCount: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findMany: mocks.lodgeFindMany,
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
      count: mocks.lodgeCount,
    },
    booking: { count: mocks.bookingCount },
    hutLeaderAssignment: { count: mocks.hutLeaderAssignmentCount },
    memberLodgeAccess: { count: mocks.memberLodgeAccessCount },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/lodges/route";
import { PATCH } from "@/app/api/admin/lodges/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] },
};
const memberSession = {
  user: { id: "member-1", role: "USER", accessRoles: ["USER"] },
};

const now = new Date("2026-07-02T10:00:00.000Z");

function lodgeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "lodge-1",
    name: "Alpine Lodge",
    slug: "alpine-lodge",
    active: true,
    doorCode: null,
    travelNote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonRequest(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/admin/lodges", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      lodge: {
        create: mocks.lodgeCreate,
        update: mocks.lodgeUpdate,
        findMany: mocks.lodgeFindMany,
      },
      auditLog: {
        create: mocks.auditLogCreate,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.bookingCount.mockResolvedValue(0);
  mocks.hutLeaderAssignmentCount.mockResolvedValue(0);
  mocks.memberLodgeAccessCount.mockResolvedValue(0);
  installTransactionMock();
});

describe("GET /api/admin/lodges", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("returns serialized lodges for admins", async () => {
    mocks.lodgeFindMany.mockResolvedValue([lodgeRecord()]);
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lodges).toHaveLength(1);
    expect(data.lodges[0]).toMatchObject({
      id: "lodge-1",
      name: "Alpine Lodge",
      slug: "alpine-lodge",
      active: true,
    });
  });
});

describe("POST /api/admin/lodges", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await POST(jsonRequest("POST", "{not json"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid input", async () => {
    const response = await POST(jsonRequest("POST", { name: "" }));
    expect(response.status).toBe(400);
  });

  it("creates a lodge with a unique slug and audit log", async () => {
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeCreate.mockResolvedValue(
      lodgeRecord({
        id: "lodge-2",
        name: "River Lodge",
        slug: "river-lodge",
        doorCode: "1234",
      }),
    );
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "River Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await POST(
      jsonRequest("POST", { name: "River Lodge", doorCode: " 1234 " }),
    );
    expect(response.status).toBe(201);
    expect(mocks.lodgeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "River Lodge",
          slug: "river-lodge",
          doorCode: "1234",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
    // Door codes are physical-access secrets: the audit log must record only
    // that one is set, never the code itself.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            newLodge: expect.objectContaining({ doorCode: "[set]" }),
          }),
        }),
      }),
    );
  });

  it("derives a suffixed slug when the base slug is taken", async () => {
    mocks.lodgeFindFirst
      .mockResolvedValueOnce({ id: "lodge-1" })
      .mockResolvedValueOnce(null);
    mocks.lodgeCreate.mockResolvedValue(
      lodgeRecord({ id: "lodge-2", slug: "alpine-lodge-2" }),
    );
    mocks.lodgeFindMany.mockResolvedValue([]);

    const response = await POST(jsonRequest("POST", { name: "Alpine Lodge" }));
    expect(response.status).toBe(201);
    expect(mocks.lodgeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "alpine-lodge-2" }),
      }),
    );
  });
});

describe("PATCH /api/admin/lodges/[id]", () => {
  it("returns 404 for an unknown lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("PATCH", { name: "Renamed" }),
      params("missing"),
    );
    expect(response.status).toBe(404);
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("rejects deactivating the last active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(0);
    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows deactivation while another active lodge exists", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Other Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("blocks deactivation and reports counts when the lodge has dependencies", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.bookingCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    mocks.hutLeaderAssignmentCount.mockResolvedValue(1);
    mocks.memberLodgeAccessCount.mockResolvedValue(0);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false }),
      params("lodge-1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("LODGE_HAS_DEPENDENCIES");
    expect(body.dependencies).toMatchObject({
      futureBookings: 2,
      hutLeaderAssignments: 1,
    });
    // Nothing was mutated — the deactivation did not proceed.
    expect(mocks.lodgeUpdate).not.toHaveBeenCalled();
  });

  it("force-deactivates past dependencies when force is set", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.bookingCount.mockResolvedValue(5);
    mocks.hutLeaderAssignmentCount.mockResolvedValue(3);
    mocks.memberLodgeAccessCount.mockResolvedValue(1);
    mocks.lodgeUpdate.mockResolvedValue(lodgeRecord({ active: false }));
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Other Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { active: false, force: true }),
      params("lodge-1"),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("updates identity fields and writes an audit log", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(lodgeRecord());
    mocks.lodgeFindFirst.mockResolvedValue(null);
    mocks.lodgeUpdate.mockResolvedValue(
      lodgeRecord({ name: "Summit Lodge", slug: "summit-lodge" }),
    );
    mocks.lodgeFindMany.mockResolvedValue([
      { name: "Summit Lodge", doorCode: null, travelNote: null },
    ]);

    const response = await PATCH(
      jsonRequest("PATCH", { name: "Summit Lodge", travelNote: "Chains required in winter." }),
      params("lodge-1"),
    );
    expect(response.status).toBe(200);
    expect(mocks.lodgeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Summit Lodge",
          slug: "summit-lodge",
          travelNote: "Chains required in winter.",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });
});
