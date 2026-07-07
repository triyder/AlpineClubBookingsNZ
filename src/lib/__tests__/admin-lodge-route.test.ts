import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn(),
    },
    memberSubscription: {
      upsert: vi.fn(),
    },
    memberLodgeAccess: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    lodge: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { GET, POST, PUT } from "@/app/api/admin/lodge/route";
import {
  adminSession,
  jsonRequest,
  memberFactory,
} from "@/lib/__tests__/helpers";

const mockedAuth = vi.mocked(auth);

function makePutRequest(body: Record<string, unknown>) {
  return jsonRequest("/api/admin/lodge", body, { method: "PUT" });
}

describe("admin lodge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a missing lodge account with a normalized LODGE access role", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    const createdRow = {
      ...memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        financeAccessLevel: "NONE",
        canLogin: true,
        createdAt: new Date("2026-04-11"),
        updatedAt: new Date("2026-04-11"),
      }),
      // Kiosk lodge binding (multi-lodge): no STAFF grants = default lodge.
      lodgeAccess: [],
    };
    vi.mocked(prisma.member.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdRow as never]);
    vi.mocked(prisma.member.create).mockResolvedValue(createdRow as never);
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(prisma.memberAccessRole.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "lodge-1", role: "LODGE", roleDefinitionId: null }],
      skipDuplicates: true,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_ACCOUNT_CREATED",
        memberId: "admin-1",
        targetId: "lodge-1",
      }),
    );
  });

  it("normalizes finance access to NONE when updating the lodge account", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        financeAccessLevel: "MANAGER",
      }),
    );
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge Desk",
        lastName: "Kiosk",
        updatedAt: new Date("2026-04-11"),
      }),
      lodgeAccess: [],
    } as never);

    const res = await PUT(makePutRequest({ firstName: "Lodge Desk" }));

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-1" },
        data: expect.objectContaining({
          firstName: "Lodge Desk",
          financeAccessLevel: "NONE",
        }),
      }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_ACCOUNT_UPDATED",
        memberId: "admin-1",
        targetId: "lodge-1",
      }),
    );
  });

  it("rebinds a kiosk account's lodge by replacing its STAFF grants", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "lodge-1", role: "LODGE" }),
    );
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: true } as never);
    const tx = {
      memberLodgeAccess: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as unknown as typeof prisma.$transaction,
    );
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...memberFactory({ id: "lodge-1", role: "LODGE" }),
      lodgeAccess: [{ lodgeId: "lodge-b", lodge: { name: "River Lodge" } }],
    } as never);

    const res = await PUT(makePutRequest({ id: "lodge-1", lodgeId: "lodge-b" }));

    expect(res.status).toBe(200);
    expect(tx.memberLodgeAccess.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "lodge-1", kind: "STAFF" },
    });
    expect(tx.memberLodgeAccess.create).toHaveBeenCalledWith({
      data: {
        memberId: "lodge-1",
        lodgeId: "lodge-b",
        kind: "STAFF",
        createdById: "admin-1",
      },
    });
    const body = await res.json();
    expect(body.account.boundLodgeId).toBe("lodge-b");
    expect(body.account.boundLodgeName).toBe("River Lodge");
  });

  it("rejects rebinding to an unknown or inactive lodge", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "lodge-1", role: "LODGE" }),
    );
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: false } as never);

    const res = await PUT(makePutRequest({ id: "lodge-1", lodgeId: "lodge-x" }));

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("creates an additional kiosk account bound to a lodge", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null); // email free
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: true } as never);
    const tx = {
      member: { create: vi.fn().mockResolvedValue({ id: "kiosk-2" }) },
      memberLodgeAccess: { create: vi.fn().mockResolvedValue({}) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as unknown as typeof prisma.$transaction,
    );
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.member.findUniqueOrThrow).mockResolvedValue({
      ...memberFactory({ id: "kiosk-2", role: "LODGE", email: "turoa-kiosk@example.org" }),
      lodgeAccess: [{ lodgeId: "lodge-b", lodge: { name: "River Lodge" } }],
    } as never);

    const res = await POST(
      jsonRequest(
        "/api/admin/lodge",
        {
          email: "Turoa-Kiosk@example.org",
          password: "kiosk-pass",
          lodgeId: "lodge-b",
        },
        { method: "POST" },
      ),
    );

    expect(res.status).toBe(201);
    expect(tx.member.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "turoa-kiosk@example.org",
          role: "LODGE",
          financeAccessLevel: "NONE",
          canLogin: true,
        }),
      }),
    );
    expect(tx.memberLodgeAccess.create).toHaveBeenCalledWith({
      data: {
        memberId: "kiosk-2",
        lodgeId: "lodge-b",
        kind: "STAFF",
        createdById: "admin-1",
      },
    });
    const body = await res.json();
    expect(body.account.boundLodgeName).toBe("River Lodge");
  });

  it("rejects creating a kiosk account with an email already in use", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "someone", email: "taken@example.org" }),
    );

    const res = await POST(
      jsonRequest(
        "/api/admin/lodge",
        { email: "taken@example.org", password: "kiosk-pass" },
        { method: "POST" },
      ),
    );

    expect(res.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
