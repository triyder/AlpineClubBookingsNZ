import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  lockerFindMany: vi.fn(),
  lockerFindFirst: vi.fn(),
  lockerFindUnique: vi.fn(),
  lockerCreate: vi.fn(),
  lockerCreateMany: vi.fn(),
  lockerUpdate: vi.fn(),
  lockerDelete: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  createAuditLog: vi.fn(),
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

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    locker: {
      findMany: mocks.lockerFindMany,
      findFirst: mocks.lockerFindFirst,
      findUnique: mocks.lockerFindUnique,
    },
    member: {
      findMany: mocks.memberFindMany,
      findFirst: mocks.memberFindFirst,
    },
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/lockers/route";
import { POST as BULK_POST } from "@/app/api/admin/lockers/bulk/route";
import {
  DELETE,
  PUT,
} from "@/app/api/admin/lockers/[id]/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };

function jsonRequest(method: "POST" | "PUT", body: unknown) {
  return new NextRequest("http://localhost/api/admin/lockers", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installTransactionMock() {
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      locker: {
        create: mocks.lockerCreate,
        createMany: mocks.lockerCreateMany,
        update: mocks.lockerUpdate,
        delete: mocks.lockerDelete,
      },
      lodge: {
        findFirst: mocks.lodgeFindFirst,
      },
    }),
  );
}

describe("admin locker routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.memberFindFirst.mockResolvedValue({ id: "member-1" });
    mocks.lockerFindFirst.mockResolvedValue(null);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mocks.createAuditLog.mockResolvedValue(undefined);
    installTransactionMock();
  });

  it("lists all lockers when no lodge filter is given", async () => {
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/lockers"),
    );

    expect(response.status).toBe(200);
    expect(mocks.lockerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("filters lockers strictly to a lodge", async () => {
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);

    const response = await GET(
      new NextRequest("http://localhost/api/admin/lockers?lodgeId=lodge-2"),
    );

    expect(response.status).toBe(200);
    expect(mocks.lockerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
  });

  it("creates a locker at an explicitly requested active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mocks.lockerCreate.mockResolvedValue({
      id: "locker-2",
      name: "Locker B1",
      allocatedToMemberId: null,
      allocatedTo: null,
    });

    const response = await POST(
      jsonRequest("POST", {
        name: "Locker B1",
        allocatedToMemberId: null,
        lodgeId: "lodge-2",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.lodgeFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lodge-2" } }),
    );
    expect(mocks.lockerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeId: "lodge-2" }),
      }),
    );
  });

  it("rejects creating a locker at an unknown or inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);

    const response = await POST(
      jsonRequest("POST", {
        name: "Locker B1",
        allocatedToMemberId: null,
        lodgeId: "lodge-missing",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.lockerCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate locker names before create", async () => {
    mocks.lockerFindFirst.mockResolvedValue({ id: "existing-locker" });

    const response = await POST(
      jsonRequest("POST", { name: "Locker A1", allocatedToMemberId: null }),
    );

    expect(response.status).toBe(409);
    expect(mocks.lockerCreate).not.toHaveBeenCalled();
  });

  it("normalizes names, creates the locker, and writes an audit event", async () => {
    mocks.lockerCreate.mockResolvedValue({
      id: "locker-1",
      name: "Locker A1",
      allocatedToMemberId: "member-1",
      allocatedTo: { id: "member-1", firstName: "Ari", lastName: "Admin" },
    });

    const response = await POST(
      jsonRequest("POST", {
        name: "  Locker   A1  ",
        allocatedToMemberId: "member-1",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.lockerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: "Locker A1",
          allocatedToMemberId: "member-1",
          lodgeId: "lodge-1",
        },
      }),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "locker.created" }),
      expect.anything(),
    );
  });

  it("renames a locker and audits the before and after allocation state", async () => {
    mocks.lockerFindUnique.mockResolvedValue({
      id: "locker-1",
      name: "Locker A1",
      allocatedToMemberId: null,
    });
    mocks.lockerUpdate.mockResolvedValue({
      id: "locker-1",
      name: "Locker B2",
      allocatedToMemberId: "member-1",
      allocatedTo: { id: "member-1", firstName: "Ari", lastName: "Admin" },
    });

    const response = await PUT(
      jsonRequest("PUT", {
        name: "Locker B2",
        allocatedToMemberId: "member-1",
      }),
      { params: Promise.resolve({ id: "locker-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.lockerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "locker-1" },
        data: {
          name: "Locker B2",
          allocatedToMemberId: "member-1",
        },
      }),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "locker.updated",
        metadata: expect.objectContaining({
          before: { name: "Locker A1", allocatedToMemberId: null },
          after: {
            name: "Locker B2",
            allocatedToMemberId: "member-1",
          },
        }),
      }),
      expect.anything(),
    );
  });

  it("deletes a locker and records the removed allocation context", async () => {
    mocks.lockerFindUnique.mockResolvedValue({
      id: "locker-1",
      name: "Locker A1",
      allocatedToMemberId: "member-1",
    });
    mocks.lockerDelete.mockResolvedValue({ id: "locker-1" });

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/lockers/locker-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "locker-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.lockerDelete).toHaveBeenCalledWith({
      where: { id: "locker-1" },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "locker.deleted",
        metadata: expect.objectContaining({
          name: "Locker A1",
          allocatedToMemberId: "member-1",
        }),
      }),
      expect.anything(),
    );
  });
});

describe("POST /api/admin/lockers/bulk (ADR-003 bulk seeding)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.lockerFindFirst.mockResolvedValue(null);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mocks.lockerCreateMany.mockResolvedValue({ count: 3 });
    mocks.createAuditLog.mockResolvedValue(undefined);
    installTransactionMock();
  });

  function bulkRequest(body: unknown) {
    return new NextRequest("http://localhost/api/admin/lockers/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates sequentially named lockers at the requested lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const response = await BULK_POST(bulkRequest({ count: 3, lodgeId: "lodge-2" }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.createdCount).toBe(3);
    expect(mocks.lockerCreateMany).toHaveBeenCalledWith({
      data: [
        { name: "Locker 1", lodgeId: "lodge-2" },
        { name: "Locker 2", lodgeId: "lodge-2" },
        { name: "Locker 3", lodgeId: "lodge-2" },
      ],
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "locker.bulk_created" }),
      expect.anything(),
    );
  });

  it("rejects the whole batch when a generated name already exists", async () => {
    mocks.lockerFindFirst.mockResolvedValue({ name: "Locker 2" });

    const response = await BULK_POST(bulkRequest({ count: 3 }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('"Locker 2" already exists');
    expect(mocks.lockerCreateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);

    const response = await BULK_POST(
      bulkRequest({ count: 3, lodgeId: "lodge-missing" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.lockerCreateMany).not.toHaveBeenCalled();
  });

  it("rejects out-of-range counts", async () => {
    const response = await BULK_POST(bulkRequest({ count: 0 }));
    expect(response.status).toBe(400);

    const tooMany = await BULK_POST(bulkRequest({ count: 101 }));
    expect(tooMany.status).toBe(400);
    expect(mocks.lockerCreateMany).not.toHaveBeenCalled();
  });

  it("honours a custom name prefix", async () => {
    const response = await BULK_POST(
      bulkRequest({ count: 2, namePrefix: "Cubby" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.lockerCreateMany).toHaveBeenCalledWith({
      data: [
        { name: "Cubby 1", lodgeId: "lodge-1" },
        { name: "Cubby 2", lodgeId: "lodge-1" },
      ],
    });
  });
});
