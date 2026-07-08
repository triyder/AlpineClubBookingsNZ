import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/admin/members/[id]/dependents/link/route";
import {
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";

type MockAccessRole = { role: string | null; roleDefinitionId?: string | null; roleDefinition?: unknown };

type MockMember = {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  ageTier: "INFANT" | "CHILD" | "YOUTH" | "ADULT";
  active: boolean;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailFromId: string | null;
  canLogin: boolean;
  role: string;
  financeAccessLevel: string;
  accessRoles: MockAccessRole[];
  dependents: Array<{ id: string }>;
  secondaryDependents: Array<{ id: string }>;
  familyGroupMemberships: Array<{ familyGroupId: string }>;
};

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
// A Membership Officer: admin-portal access but not a Full Admin.
const officerSession = { user: { id: "officer-1", role: "USER", accessRoles: [{ role: "ADMIN_MEMBERSHIP" }] } } as any;
const adminAccessRoles: MockAccessRole[] = [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }];

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/members/parent-1/dependents/link", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeParent(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "parent-1",
    firstName: "Parent",
    lastName: "Member",
    email: "parent@example.com",
    ageTier: "ADULT",
    active: true,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    canLogin: true,
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [],
    dependents: [],
    secondaryDependents: [],
    familyGroupMemberships: [{ familyGroupId: "fg-1" }, { familyGroupId: "fg-2" }],
    ...overrides,
  };
}

function makeMember(overrides: Partial<MockMember> = {}): MockMember {
  return {
    id: "target-1",
    firstName: "Target",
    lastName: "Member",
    email: "target@example.com",
    ageTier: "CHILD",
    active: true,
    parentMemberId: null,
    secondaryParentId: null,
    inheritEmailFromId: null,
    canLogin: true,
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [],
    dependents: [],
    secondaryDependents: [],
    familyGroupMemberships: [],
    ...overrides,
  };
}

function setupTransaction(members: MockMember[]) {
  const membersById = new Map(members.map((member) => [member.id, member]));

  const tx = {
    member: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return membersById.get(where.id) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: any }) => {
        // Last-admin guard query (ACTIVE_FULL_ADMIN_WHERE): active + login +
        // ADMIN access-role row, optionally scoped to one id or excluding a set.
        if (where.accessRoles) {
          return members.filter((member) => {
            if (!member.active || !member.canLogin) return false;
            const holdsAdmin = member.accessRoles.some((r) => r.role === "ADMIN");
            if (!holdsAdmin) return false;
            if (typeof where.id === "string") return member.id === where.id;
            if (where.id?.notIn) return !where.id.notIn.includes(member.id);
            return true;
          }).length;
        }
        // Shared-email orphan check.
        return members.filter((member) => member.email === where.email && member.id !== where.id.not).length;
      }),
      findFirst: vi.fn(async ({ where }: { where: { email: string; id: { not: string }; canLogin: boolean } }) => {
        return members.find(
          (member) =>
            member.email === where.email &&
            member.id !== where.id.not &&
            member.canLogin === where.canLogin
        ) ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const member = membersById.get(where.id);
        if (!member) return null;
        return {
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          ageTier: member.ageTier,
          parentMemberId: data.parent?.connect?.id ?? member.parentMemberId,
          secondaryParentId: data.secondaryParent?.connect?.id ?? member.secondaryParentId,
          inheritEmailFromId: data.inheritEmailFrom?.connect?.id ?? member.inheritEmailFromId,
          canLogin: data.canLogin ?? member.canLogin,
        };
      }),
    },
    familyGroupMember: {
      upsert: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
  };

  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(tx));

  return tx;
}

async function linkDependent(body: Record<string, unknown>, parentId = "parent-1") {
  return POST(makeRequest(body), { params: Promise.resolve({ id: parentId }) });
}

describe("POST /api/admin/members/[id]/dependents/link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(adminSession);
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("links a child with default side effects", async () => {
    const tx = setupTransaction([makeParent(), makeMember({ ageTier: "CHILD" })]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: ["fg-1", "fg-2"],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1" },
        data: expect.objectContaining({
          parent: { connect: { id: "parent-1" } },
          inheritParentEmail: true,
          inheritEmailFrom: { connect: { id: "parent-1" } },
          canLogin: false,
        }),
      })
    );
    expect(tx.familyGroupMember.upsert).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "member.dependent.link",
          memberId: "admin-1",
          targetId: "target-1",
        }),
      })
    );
  });

  it("links an adult with all side effects off", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ ageTier: "ADULT", canLogin: true, inheritEmailFromId: "existing-source" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { parent: { connect: { id: "parent-1" } } },
      })
    );
    expect(tx.familyGroupMember.upsert).not.toHaveBeenCalled();
  });

  it("links a target that already has one parent as a second parent", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ parentMemberId: "other-parent" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(200);
    expect(tx.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1" },
        data: expect.objectContaining({
          secondaryParent: { connect: { id: "parent-1" } },
          inheritParentEmail: true,
          inheritEmailFrom: { connect: { id: "parent-1" } },
        }),
      })
    );
  });

  it("rejects a target that already has two parents", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ parentMemberId: "other-parent", secondaryParentId: "second-parent" }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/two parents/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects a target that already has dependants", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ dependents: [{ id: "child-1" }] }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: true,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/already has dependants/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects disabling login when it would orphan a shared-email cluster", async () => {
    const tx = setupTransaction([
      makeParent(),
      makeMember({ email: "shared@example.com", canLogin: true }),
      makeMember({
        id: "shared-dependent",
        email: "shared@example.com",
        canLogin: false,
      }),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: true,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/only login holder/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects linking the parent's parent as a dependant", async () => {
    const tx = setupTransaction([
      makeParent({ parentMemberId: "grandparent-1" }),
      makeMember({
        id: "grandparent-1",
        email: "grandparent@example.com",
        ageTier: "ADULT",
        canLogin: true,
      }),
    ]);

    const res = await linkDependent({
      memberId: "grandparent-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: [],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/ancestor/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it("rejects family groups that the parent does not belong to", async () => {
    const tx = setupTransaction([
      makeParent({ familyGroupMemberships: [{ familyGroupId: "fg-1" }] }),
      makeMember(),
    ]);

    const res = await linkDependent({
      memberId: "target-1",
      inheritEmail: false,
      disableLogin: false,
      addToFamilyGroupIds: ["fg-2"],
    });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/family groups the parent belongs to/i);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  describe("admin-account guards (#1604/#1622)", () => {
    it("blocks a Membership Officer from de-logging an admin-holding account", async () => {
      vi.mocked(auth).mockResolvedValue(officerSession);
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "adminuser@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(PRIVILEGED_TARGET_GUARD_MESSAGE);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("blocks de-logging the last active Full Admin", async () => {
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "lastadmin@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(LAST_FULL_ADMIN_GUARD_MESSAGE);
      expect(tx.member.update).not.toHaveBeenCalled();
    });

    it("allows de-logging a Full Admin target when another active Full Admin survives", async () => {
      // Target IS a Full Admin, so wouldRemoveLastFullAdmin does not
      // short-circuit — it counts survivors. The parent is a second active
      // Full Admin, so the end-state count is non-zero and the flip is allowed.
      const tx = setupTransaction([
        makeParent({ role: "ADMIN", accessRoles: adminAccessRoles }),
        makeMember({
          ageTier: "ADULT",
          email: "survivingadmintarget@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: true,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "target-1" },
          data: expect.objectContaining({ canLogin: false }),
        })
      );
    });

    it("leaves the disableLogin:false path unguarded (no de-login, admin target allowed)", async () => {
      vi.mocked(auth).mockResolvedValue(officerSession);
      const tx = setupTransaction([
        makeParent(),
        makeMember({
          ageTier: "ADULT",
          email: "adminuser@example.com",
          canLogin: true,
          role: "ADMIN",
          accessRoles: adminAccessRoles,
        }),
      ]);

      const res = await linkDependent({
        memberId: "target-1",
        inheritEmail: false,
        disableLogin: false,
        addToFamilyGroupIds: [],
      });

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { parent: { connect: { id: "parent-1" } } },
        })
      );
    });
  });
});
