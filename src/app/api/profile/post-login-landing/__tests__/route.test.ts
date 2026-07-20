import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Post-login landing write route (#2090). Mirrors the notification-preferences
// audit sibling: prisma + auth + the active-session guard are mocked, but the
// real admin-permission resolver and audit builders run so the access gate and
// the structured audit payload are exercised end-to-end.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }
      return (operation as (tx: unknown) => Promise<unknown>)({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser =
  vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (
    ...args: Parameters<typeof mockRequireActiveSessionUser>
  ) => mockRequireActiveSessionUser(...args),
}));

import { GET, PUT } from "@/app/api/profile/post-login-landing/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ADMIN_ROLE = { role: "ADMIN" } as const;
const MEMBER_ROLE = { role: "USER" } as const;

type MemberFixture = {
  postLoginLanding: string | null;
  canLogin: boolean;
  role: string;
  financeAccessLevel: string;
  accessRoles: Array<Record<string, unknown>>;
};

function member(overrides: Partial<MemberFixture> = {}): MemberFixture {
  return {
    postLoginLanding: null,
    canLogin: true,
    role: "MEMBER",
    financeAccessLevel: "NONE",
    accessRoles: [ADMIN_ROLE],
    ...overrides,
  };
}

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/profile/post-login-landing", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Vitest",
      "X-Forwarded-For": "198.51.100.1",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "member-1" } } as never);
  vi.mocked(prisma.member.update).mockResolvedValue({ id: "member-1" } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
});

describe("PUT /api/profile/post-login-landing (#2090)", () => {
  it("401s an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PUT(putRequest({ postLoginLanding: "ADMIN_DASHBOARD" }));
    expect(res.status).toBe(401);
    expect(prisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("403s a plain member with no accessible admin page", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ accessRoles: [MEMBER_ROLE] }) as never,
    );
    const res = await PUT(putRequest({ postLoginLanding: "ADMIN_DASHBOARD" }));
    expect(res.status).toBe(403);
    expect(prisma.member.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("403s a member whose only access-role row resolves to no admin area", async () => {
    // A custom-role assignment selected without its definition (role: null)
    // contributes nothing to the matrix — fail closed, so the write is rejected.
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ accessRoles: [{ role: null }] }) as never,
    );
    const res = await PUT(putRequest({ postLoginLanding: "MEMBER_DASHBOARD" }));
    expect(res.status).toBe(403);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("persists a changed value and writes an audit row with before/after", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ postLoginLanding: null }) as never,
    );

    const res = await PUT(putRequest({ postLoginLanding: "MEMBER_DASHBOARD" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postLoginLanding: "MEMBER_DASHBOARD",
      canChoose: true,
    });

    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { postLoginLanding: "MEMBER_DASHBOARD" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.post_login_landing.updated",
        actorMemberId: "member-1",
        subjectMemberId: "member-1",
        category: "account",
        severity: "important",
        metadata: { before: null, after: "MEMBER_DASHBOARD" },
        ipAddress: "198.51.100.1",
        userAgent: "Vitest",
      }),
    });
  });

  it("records before/after when clearing the preference back to the default", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ postLoginLanding: "ADMIN_DASHBOARD" }) as never,
    );

    const res = await PUT(putRequest({ postLoginLanding: null }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postLoginLanding: null,
      canChoose: true,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "member.post_login_landing.updated",
        metadata: { before: "ADMIN_DASHBOARD", after: null },
      }),
    });
  });

  it("writes no audit row when the value is unchanged", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ postLoginLanding: "ADMIN_DASHBOARD" }) as never,
    );

    const res = await PUT(putRequest({ postLoginLanding: "ADMIN_DASHBOARD" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postLoginLanding: "ADMIN_DASHBOARD",
      canChoose: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.member.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("400s an invalid enum value", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(member() as never);
    const res = await PUT(putRequest({ postLoginLanding: "BOGUS" }));
    expect(res.status).toBe(400);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("400s a malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/profile/post-login-landing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/profile/post-login-landing (#2090)", () => {
  it("401s an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the current value and canChoose:true for an admin", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ postLoginLanding: "ADMIN_DASHBOARD" }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postLoginLanding: "ADMIN_DASHBOARD",
      canChoose: true,
    });
  });

  it("returns canChoose:false for a member with no accessible admin page", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      member({ postLoginLanding: null, accessRoles: [MEMBER_ROLE] }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      postLoginLanding: null,
      canChoose: false,
    });
  });
});
