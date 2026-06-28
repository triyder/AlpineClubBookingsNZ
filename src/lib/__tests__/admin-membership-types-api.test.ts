import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  membershipTypeUpsert: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  membershipTypeFindFirst: vi.fn(),
  membershipTypeCreate: vi.fn(),
  membershipTypeUpdate: vi.fn(),
  membershipTypeDelete: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
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
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipType: {
      upsert: mocks.membershipTypeUpsert,
      findMany: mocks.membershipTypeFindMany,
      findUnique: mocks.membershipTypeFindUnique,
      findFirst: mocks.membershipTypeFindFirst,
      create: mocks.membershipTypeCreate,
      update: mocks.membershipTypeUpdate,
      delete: mocks.membershipTypeDelete,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    member: {
      findMany: vi.fn(),
    },
    seasonalMembershipAssignment: {
      createMany: vi.fn(),
    },
    $transaction: mocks.transaction,
  },
}));

import {
  GET as getMembershipTypes,
  POST as createMembershipType,
} from "@/app/api/admin/membership-types/route";
import {
  DELETE as deleteMembershipType,
  PATCH as updateMembershipType,
} from "@/app/api/admin/membership-types/[id]/route";
import { POST as reorderMembershipTypes } from "@/app/api/admin/membership-types/reorder/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };
const memberSession = { user: { id: "member-1", role: "MEMBER" } };

function membershipType(overrides: Record<string, unknown> = {}) {
  return {
    id: "type-1",
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    _count: { assignments: 2 },
    ...overrides,
  };
}

function request(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req-1",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("Admin membership types API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.membershipTypeUpsert.mockResolvedValue({});
    mocks.membershipTypeFindMany.mockResolvedValue([membershipType()]);
    mocks.membershipTypeFindUnique.mockResolvedValue(null);
    mocks.membershipTypeFindFirst.mockResolvedValue({ sortOrder: 3 });
    mocks.membershipTypeCreate.mockImplementation(async ({ data }) =>
      membershipType({
        id: "type-custom",
        key: data.key,
        name: data.name,
        description: data.description,
        isActive: data.isActive,
        isBuiltIn: false,
        bookingBehavior: data.bookingBehavior,
        subscriptionBehavior: data.subscriptionBehavior,
        sortOrder: data.sortOrder,
        _count: { assignments: 0 },
      }),
    );
    mocks.membershipTypeUpdate.mockImplementation(async ({ data }) =>
      membershipType({
        ...data,
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );
    mocks.membershipTypeDelete.mockResolvedValue({});
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        membershipType: {
          create: mocks.membershipTypeCreate,
          update: mocks.membershipTypeUpdate,
          delete: mocks.membershipTypeDelete,
        },
        auditLog: {
          create: mocks.auditLogCreate,
        },
      }),
    );
  });

  it("prevents non-admin users from reading membership types", async () => {
    mocks.auth.mockResolvedValue(memberSession);

    const response = await getMembershipTypes();

    expect(response.status).toBe(403);
    expect(mocks.membershipTypeFindMany).not.toHaveBeenCalled();
  });

  it("returns membership types with assignment counts for admins", async () => {
    const response = await getMembershipTypes();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.membershipTypeUpsert).not.toHaveBeenCalled();
    expect(body.membershipTypes).toEqual([
      expect.objectContaining({
        id: "type-1",
        key: "FULL",
        assignmentCount: 2,
      }),
    ]);
  });

  it("rejects unknown fields so stable identifiers cannot be mutated", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        key: "MUTATED",
        name: "Social",
        bookingBehavior: "MEMBER_RATE",
        subscriptionBehavior: "REQUIRED",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.membershipTypeCreate).not.toHaveBeenCalled();
  });

  it("creates custom membership types and writes structured audit", async () => {
    const response = await createMembershipType(
      request("http://localhost/api/admin/membership-types", {
        name: "Social member",
        description: "Social membership",
        bookingBehavior: "NON_MEMBER_RATE",
        subscriptionBehavior: "NOT_REQUIRED",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.membershipType.key).toBe("SOCIAL_MEMBER");
    expect(mocks.membershipTypeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "SOCIAL_MEMBER",
          name: "Social member",
          isBuiltIn: false,
          bookingBehavior: "NON_MEMBER_RATE",
          subscriptionBehavior: "NOT_REQUIRED",
          sortOrder: 4,
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_CREATED",
          actor: { memberId: "admin-1" },
          entity: { type: "MembershipType", id: "type-custom" },
        }),
      }),
    );
  });

  it("archives and reactivates membership types through audited updates", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const archived = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { isActive: false },
        "PATCH",
      ),
      params("type-custom"),
    );

    expect(archived.status).toBe(200);
    expect(mocks.auditLogCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_ARCHIVED",
        }),
      }),
    );

    mocks.membershipTypeFindUnique.mockResolvedValueOnce(
      membershipType({
        id: "type-custom",
        key: "SOCIAL_MEMBER",
        isActive: false,
        isBuiltIn: false,
        _count: { assignments: 0 },
      }),
    );

    const reactivated = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-custom",
        { isActive: true },
        "PATCH",
      ),
      params("type-custom"),
    );

    expect(reactivated.status).toBe(200);
    expect(mocks.auditLogCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPE_REACTIVATED",
        }),
      }),
    );
  });

  it("rejects identifier mutation on update payloads", async () => {
    const response = await updateMembershipType(
      request(
        "http://localhost/api/admin/membership-types/type-1",
        { key: "MUTATED" },
        "PATCH",
      ),
      params("type-1"),
    );

    expect(response.status).toBe(400);
    expect(mocks.membershipTypeUpdate).not.toHaveBeenCalled();
  });

  it("reorders membership types and audits previous and new order", async () => {
    mocks.membershipTypeFindMany
      .mockResolvedValueOnce([
        membershipType({ id: "type-full", key: "FULL", sortOrder: 0 }),
        membershipType({ id: "type-life", key: "LIFE", sortOrder: 1 }),
      ])
      .mockResolvedValueOnce([
        membershipType({ id: "type-life", key: "LIFE", sortOrder: 0 }),
        membershipType({ id: "type-full", key: "FULL", sortOrder: 1 }),
      ]);

    const response = await reorderMembershipTypes(
      request("http://localhost/api/admin/membership-types/reorder", {
        orderedIds: ["type-life", "type-full"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.membershipTypes.map((type: { id: string }) => type.id)).toEqual([
      "type-life",
      "type-full",
    ]);
    expect(mocks.membershipTypeUpdate).toHaveBeenCalledWith({
      where: { id: "type-life" },
      data: { sortOrder: 0 },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_TYPES_REORDERED",
        }),
      }),
    );
  });

  it("protects built-in membership types from deletion", async () => {
    mocks.membershipTypeFindUnique.mockResolvedValue(
      membershipType({ id: "type-full", isBuiltIn: true }),
    );

    const response = await deleteMembershipType(
      new NextRequest("http://localhost/api/admin/membership-types/type-full", {
        method: "DELETE",
      }),
      params("type-full"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("Built-in");
    expect(mocks.membershipTypeDelete).not.toHaveBeenCalled();
  });
});
