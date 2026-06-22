import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  lockerFindMany: vi.fn(),
  lockerFindFirst: vi.fn(),
  lockerFindUnique: vi.fn(),
  lockerCreate: vi.fn(),
  lockerUpdate: vi.fn(),
  lockerDelete: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
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
    $transaction: mocks.transaction,
  },
}));

import { POST } from "@/app/api/admin/lockers/route";
import {
  DELETE,
  PUT,
} from "@/app/api/admin/lockers/[id]/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };

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
        update: mocks.lockerUpdate,
        delete: mocks.lockerDelete,
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
    mocks.createAuditLog.mockResolvedValue(undefined);
    installTransactionMock();
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
