import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn(),
    },
    memberSubscription: {
      upsert: vi.fn(),
    },
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
import { GET, PUT } from "@/app/api/admin/lodge/route";
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
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.create).mockResolvedValue(
      memberFactory({
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
    );
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(prisma.memberAccessRole.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "lodge-1", role: "LODGE" }],
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
    vi.mocked(prisma.member.update).mockResolvedValue(
      memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge Desk",
        lastName: "Kiosk",
        updatedAt: new Date("2026-04-11"),
      }),
    );

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
});
