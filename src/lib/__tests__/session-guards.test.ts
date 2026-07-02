import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { mockFindUnique, mockAuth } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

import {
  requireActiveSession,
  requireActiveSessionUser,
  requireAdmin,
} from "@/lib/session-guards";

describe("requireActiveSessionUser", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it("rejects deactivated sessions", async () => {
    mockFindUnique.mockResolvedValue({ active: false, forcePasswordChange: false });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
  });

  it("rejects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Password change required",
    });
  });

  it("allows the password change endpoint to opt out of the force-password block", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1", {
      allowForcePasswordChange: true,
    });

    expect(response).toBeNull();
  });

  it("rejects unverified sessions when two-factor is required", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: true,
    });

    const response = await requireActiveSessionUser("member-1", {
      sessionUser: {
        id: "member-1",
        twoFactorRequired: true,
        twoFactorVerified: false,
      },
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Two-factor verification required",
    });
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
  });

  it("allows routes to preserve a legacy non-admin envelope", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "MEMBER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "USER" }],
    });

    const result = await requireAdmin({
      forbiddenResponse: () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({ error: "Unauthorized" });
    }
  });

  it("returns the admin session after the active-session check passes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.user.id).toBe("admin-1");
    }
  });

  it("allows bundled admin roles when the requested admin area permits them", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "booking-office-1",
        role: "USER",
        accessRoles: [{ role: "ADMIN_BOOKINGS" }],
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN_BOOKINGS" }],
    });

    const result = await requireAdmin({
      permission: { area: "bookings", level: "edit" },
    });

    expect(result.ok).toBe(true);
  });

  it("blocks read-only admin roles from edit-level admin routes", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "readonly-admin-1",
        role: "USER",
        accessRoles: [{ role: "ADMIN_READONLY" }],
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN_READONLY" }],
    });

    const result = await requireAdmin({
      permission: { area: "bookings", level: "edit" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("rejects inactive admins through the active-session check", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Account is deactivated",
      });
    }
  });

  it("rejects admins who must change their password", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: true,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Password change required",
      });
    }
  });

  it("rejects admins who have not completed required two-factor verification", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "admin-1",
        role: "ADMIN",
        accessRoles: [{ role: "ADMIN" }],
        twoFactorRequired: true,
        twoFactorVerified: false,
      },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      twoFactorEnabled: true,
      accessRoles: [{ role: "ADMIN" }],
    });

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: "Two-factor verification required",
      });
    }
  });
});

describe("requireActiveSession", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockAuth.mockReset();
  });

  it("rejects unauthenticated API callers with the member-route envelope", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await requireActiveSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: "Unauthorised",
      });
    }
  });

  it("returns the session after active-account checks pass", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false });

    const result = await requireActiveSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.user.id).toBe("member-1");
    }
  });
});
