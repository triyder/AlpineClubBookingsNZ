import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberFindUnique: vi.fn(),
  lodgeFindMany: vi.fn(),
  memberLodgeAccessFindMany: vi.fn(),
  memberLodgeAccessDeleteMany: vi.fn(),
  memberLodgeAccessCreateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
    lodge: {
      findMany: mocks.lodgeFindMany,
    },
    memberLodgeAccess: {
      findMany: mocks.memberLodgeAccessFindMany,
      deleteMany: mocks.memberLodgeAccessDeleteMany,
      createMany: mocks.memberLodgeAccessCreateMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, PUT } from "@/app/api/admin/members/[id]/lodge-access/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] },
};
const memberSession = {
  user: { id: "member-1", role: "USER", accessRoles: ["USER"] },
};

const now = new Date("2026-07-02T10:00:00.000Z");

function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "access-1",
    lodgeId: "lodge-1",
    kind: "BOOKING_RESTRICTION",
    createdAt: now,
    ...overrides,
  };
}

function jsonRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/members/member-1/lodge-access",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function params(id = "member-1") {
  return { params: Promise.resolve({ id }) };
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      memberLodgeAccess: {
        deleteMany: mocks.memberLodgeAccessDeleteMany,
        createMany: mocks.memberLodgeAccessCreateMany,
        findMany: mocks.memberLodgeAccessFindMany,
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
  mocks.memberFindUnique.mockResolvedValue({ id: "member-1" });
  mocks.memberLodgeAccessDeleteMany.mockResolvedValue({ count: 0 });
  mocks.memberLodgeAccessCreateMany.mockResolvedValue({ count: 0 });
  mocks.auditLogCreate.mockResolvedValue({});
  installTransactionMock();
});

describe("GET /api/admin/members/[id]/lodge-access", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET(
      new NextRequest("http://localhost/api/admin/members/member-1/lodge-access"),
      params(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await GET(
      new NextRequest("http://localhost/api/admin/members/member-1/lodge-access"),
      params(),
    );
    expect(response.status).toBe(403);
  });

  it("returns 404 when the member does not exist", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    const response = await GET(
      new NextRequest("http://localhost/api/admin/members/missing/lodge-access"),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("returns the member's lodge access rows partitioned by kind", async () => {
    mocks.memberLodgeAccessFindMany.mockResolvedValue([
      accessRow({ id: "access-1", kind: "BOOKING_RESTRICTION", lodgeId: "lodge-1" }),
      accessRow({ id: "access-2", kind: "STAFF", lodgeId: "lodge-2" }),
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/members/member-1/lodge-access"),
      params(),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lodgeAccess).toHaveLength(2);
    expect(data.bookingRestrictions).toEqual([
      expect.objectContaining({ id: "access-1", lodgeId: "lodge-1" }),
    ]);
    expect(data.staffGrants).toEqual([
      expect.objectContaining({ id: "access-2", lodgeId: "lodge-2" }),
    ]);
  });
});

describe("PUT /api/admin/members/[id]/lodge-access", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await PUT(
      jsonRequest({ bookingRestrictionLodgeIds: [], staffLodgeIds: [] }),
      params(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await PUT(
      jsonRequest({ bookingRestrictionLodgeIds: [], staffLodgeIds: [] }),
      params(),
    );
    expect(response.status).toBe(403);
  });

  it("returns 404 when the member does not exist", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    const response = await PUT(
      jsonRequest({ bookingRestrictionLodgeIds: [], staffLodgeIds: [] }),
      params("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await PUT(jsonRequest("{not json"), params());
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid JSON");
  });

  it("returns 400 for a non-strict / invalid body shape", async () => {
    const response = await PUT(
      jsonRequest({ bookingRestrictionLodgeIds: "lodge-1", staffLodgeIds: [] }),
      params(),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when a lodge id does not exist", async () => {
    mocks.lodgeFindMany.mockResolvedValue([{ id: "lodge-1" }]);
    const response = await PUT(
      jsonRequest({
        bookingRestrictionLodgeIds: ["lodge-1", "lodge-missing"],
        staffLodgeIds: [],
      }),
      params(),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.details.unknownLodgeIds).toEqual(["lodge-missing"]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("replaces rows of each kind inside one transaction and writes one audit log", async () => {
    mocks.lodgeFindMany.mockResolvedValue([
      { id: "lodge-1" },
      { id: "lodge-2" },
    ]);
    mocks.memberLodgeAccessFindMany
      // previous rows lookup (before the transaction)
      .mockResolvedValueOnce([
        { lodgeId: "lodge-old", kind: "BOOKING_RESTRICTION" },
      ])
      // final findMany inside the transaction, returned to the caller
      .mockResolvedValueOnce([
        accessRow({ id: "access-1", kind: "BOOKING_RESTRICTION", lodgeId: "lodge-1" }),
        accessRow({ id: "access-2", kind: "STAFF", lodgeId: "lodge-2" }),
      ]);

    const response = await PUT(
      jsonRequest({
        bookingRestrictionLodgeIds: ["lodge-1"],
        staffLodgeIds: ["lodge-2"],
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    expect(mocks.memberLodgeAccessDeleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", kind: "BOOKING_RESTRICTION" },
    });
    expect(mocks.memberLodgeAccessDeleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", kind: "STAFF" },
    });
    expect(mocks.memberLodgeAccessCreateMany).toHaveBeenCalledWith({
      data: [
        {
          memberId: "member-1",
          lodgeId: "lodge-1",
          kind: "BOOKING_RESTRICTION",
          createdById: "admin-1",
        },
      ],
    });
    expect(mocks.memberLodgeAccessCreateMany).toHaveBeenCalledWith({
      data: [
        {
          memberId: "member-1",
          lodgeId: "lodge-2",
          kind: "STAFF",
          createdById: "admin-1",
        },
      ],
    });

    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    const auditArgs = mocks.auditLogCreate.mock.calls[0][0];
    expect(auditArgs.data.action).toBe("MEMBER_LODGE_ACCESS_UPDATED");
    expect(auditArgs.data.entityType).toBe("Member");
    expect(auditArgs.data.entityId).toBe("member-1");

    const data = await response.json();
    expect(data.bookingRestrictions).toHaveLength(1);
    expect(data.staffGrants).toHaveLength(1);
  });

  it("skips createMany when a kind's list is empty", async () => {
    mocks.lodgeFindMany.mockResolvedValue([]);
    mocks.memberLodgeAccessFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const response = await PUT(
      jsonRequest({ bookingRestrictionLodgeIds: [], staffLodgeIds: [] }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.memberLodgeAccessDeleteMany).toHaveBeenCalledTimes(2);
    expect(mocks.memberLodgeAccessCreateMany).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });
});
