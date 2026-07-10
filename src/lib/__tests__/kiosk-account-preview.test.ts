import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #23: a full admin can preview the kiosk exactly as a specific kiosk
// (LODGE) account would see it, via `?previewAccount=<memberId>`. These tests
// pin the security-critical guarantees:
//  - preview is honoured only for a full admin, only on read (allowPreview)
//    routes; a mutation route (allowPreview unset) rejects it (read-only);
//  - a non-admin carrying the parameter is ignored (normal kiosk auth);
//  - the previewed lodge is the TARGET account's, not the admin's.

const { mockPrisma, mockAuth, mockPinSession } = vi.hoisted(() => ({
  mockPrisma: {
    member: { findUnique: vi.fn() },
    memberLodgeAccess: { findMany: vi.fn() },
    lodge: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    hutLeaderAssignment: { count: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    booking: { count: vi.fn(), findFirst: vi.fn() },
    bookingGuest: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockPinSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/lodge-pin-session", () => ({
  getActiveLodgePinSessionForRequest: (...args: unknown[]) => mockPinSession(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const ADMIN = { id: "admin-1", email: "admin@example.org", accessRoles: [{ role: "ADMIN" }] };
const KIOSK_B = { id: "kiosk-b", email: "kiosk-b@example.org", accessRoles: [{ role: "LODGE" }] };
const PLAIN_USER = { id: "user-1", email: "user-1@example.org", accessRoles: [{ role: "USER" }] };
const LODGE_SELF = { id: "lodge-self", email: "lodge-self@example.org", accessRoles: [{ role: "LODGE" }] };

function memberById(row: Record<string, unknown>) {
  return ({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === row.id ? row : null);
}

function previewRequest(path: string, previewAccount: string, init?: RequestInit) {
  return new Request(
    `http://localhost${path}?previewAccount=${encodeURIComponent(previewAccount)}`,
    init
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPinSession.mockResolvedValue(null);
  mockPrisma.member.findUnique.mockResolvedValue(null);
  mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
  mockPrisma.lodge.count.mockResolvedValue(2);
  mockPrisma.lodge.findUnique.mockResolvedValue({ name: "Lodge B" });
  mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
});

describe("checkLodgeAuth per-account preview (issue #23)", () => {
  it("rejects preview as read-only on a route that does not allow it", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(memberById(ADMIN));

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/guests/2026-04-13/arrive", KIOSK_B.id),
      // allowPreview omitted → default-deny
    });

    expect(result.status).toBe(403);
    expect(result.error).toBe("Kiosk preview is read-only");
    // The target account is never even looked up when preview is denied.
    expect(mockPrisma.member.findUnique).toHaveBeenCalledTimes(1);
  });

  it("resolves the target kiosk account when an admin previews a read route", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === ADMIN.id ? ADMIN : where.id === KIOSK_B.id ? KIOSK_B : null)
    );

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/access", KIOSK_B.id),
      allowPreview: true,
    });

    expect(result.error).toBeNull();
    expect(result.tier).toBe("lodge");
    expect(result.member?.id).toBe(KIOSK_B.id);
    expect("preview" in result && result.preview).toEqual({
      actorMemberId: ADMIN.id,
      targetMemberId: KIOSK_B.id,
      targetEmail: KIOSK_B.email,
    });
  });

  it("404s when the preview target is not a kiosk (LODGE) account", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === ADMIN.id ? ADMIN : where.id === PLAIN_USER.id ? PLAIN_USER : null)
    );

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/access", PLAIN_USER.id),
      allowPreview: true,
    });

    expect(result.status).toBe(404);
    expect(result.error).toBe("Kiosk account not found");
  });

  it("404s when the preview target does not exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(memberById(ADMIN));

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/access", "ghost"),
      allowPreview: true,
    });

    expect(result.status).toBe(404);
  });

  it("ignores the preview parameter for a non-admin and applies normal auth", async () => {
    mockAuth.mockResolvedValue({ user: { id: LODGE_SELF.id } });
    mockPrisma.member.findUnique.mockImplementation(memberById(LODGE_SELF));

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/access", KIOSK_B.id),
      allowPreview: true,
    });

    expect(result.error).toBeNull();
    expect(result.tier).toBe("lodge");
    // Resolved as the caller's own account, never the preview target.
    expect(result.member?.id).toBe(LODGE_SELF.id);
    expect("preview" in result && result.preview).toBeFalsy();
  });

  it("resolves the preview lodge from the TARGET account's binding, not the admin's", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === ADMIN.id ? ADMIN : where.id === KIOSK_B.id ? KIOSK_B : null)
    );

    const { checkLodgeAuth, resolveKioskLodgeId } = await import("@/lib/lodge-auth");
    const authResult = await checkLodgeAuth("2026-04-13", {
      request: previewRequest("/api/lodge/access", KIOSK_B.id),
      allowPreview: true,
    });

    // The target account is bound to lodge-B.
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([{ lodgeId: "lodge-B" }]);
    const lodgeId = await resolveKioskLodgeId(authResult, mockPrisma as never);

    expect(lodgeId).toBe("lodge-B");
    expect(mockPrisma.memberLodgeAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { memberId: KIOSK_B.id, kind: "STAFF" } })
    );
  });
});

describe("kiosk preview at the route boundary (issue #23)", () => {
  it("a mutation route rejects a preview request with 403 (write suppression)", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(memberById(ADMIN));

    const { NextRequest } = await import("next/server");
    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(
      new NextRequest(
        "http://localhost/api/lodge/guests/2026-04-13/arrive?previewAccount=kiosk-b",
        {
          method: "PUT",
          body: JSON.stringify({ bookingGuestId: "guest-1" }),
          headers: { "content-type": "application/json" },
        }
      ),
      { params: Promise.resolve({ date: "2026-04-13" }) }
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Kiosk preview is read-only" });
    // No guest was touched.
    expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("the access route returns the previewed lodge and marks the session a preview", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN.id } });
    mockPrisma.member.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === ADMIN.id ? ADMIN : where.id === KIOSK_B.id ? KIOSK_B : null)
    );
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([{ lodgeId: "lodge-B" }]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/lodge/access?date=2026-04-13&previewAccount=kiosk-b"
      )
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe("lodge");
    expect(body.preview).toBe(true);
    expect(body.previewAccountEmail).toBe(KIOSK_B.email);
    expect(body.lodgeName).toBe("Lodge B");
  });
});
