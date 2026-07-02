import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindUnique,
  mockFindFirst,
  mockUpdate,
  mockNextAuth,
  mockRawAuth,
  mockLoadEffectiveModuleFlags,
  mockConsumeTwoFactorSessionChallenge,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockRawAuth: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockConsumeTwoFactorSessionChallenge: vi.fn(),
  mockNextAuth: vi.fn(() => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: mockRawAuth,
    unstable_update: vi.fn(),
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
      findFirst: mockFindFirst,
      update: mockUpdate,
    },
  },
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret"),
  getAuthTrustHost: vi.fn(() => true),
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config) => config),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }

  return {
    default: mockNextAuth,
    CredentialsSignin,
  };
});

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));

vi.mock("@/lib/two-factor", () => ({
  consumeTwoFactorSessionChallenge: mockConsumeTwoFactorSessionChallenge,
}));

import { auth, authConfig } from "@/lib/auth";

describe("auth session refresh", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFindFirst.mockReset();
    mockUpdate.mockReset();
    mockRawAuth.mockReset();
    mockLoadEffectiveModuleFlags.mockReset();
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: false });
    mockConsumeTwoFactorSessionChallenge.mockReset();
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
  });

  it("refreshes a stale admin JWT role from the database", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "ADMIN",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
    } as never);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: {
        role: true,
        accessRoles: { select: { role: true } },
        forcePasswordChange: true,
        emailVerified: true,
        passwordChangedAt: true,
        twoFactorEnabled: true,
        twoFactorMethod: true,
      },
    });
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        id: "member-1",
        role: "MEMBER",
        accessRoles: ["USER"],
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: false,
      })
    );
  });

  it("marks the session invalid when the password changed after issuance", async () => {
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: new Date("2026-04-26T10:00:00.000Z"),
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: new Date("2026-04-26T09:00:00.000Z").getTime(),
      },
    } as never);

    expect(refreshedToken).toEqual(
      expect.objectContaining({
        sessionInvalidated: true,
      })
    );
  });

  it("does not trust a password-only JWT when two-factor is later enabled", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "TOTP",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
        twoFactorVerified: true,
      },
    } as never);

    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "TOTP",
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("ignores a forged session update that claims twoFactorVerified without a challenge token", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    // The exact payload an attacker can POST to /api/auth/session.
    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: { user: { twoFactorVerified: true } },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).not.toHaveBeenCalled();
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "EMAIL",
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );

    // A forged update must not seed verification into later refreshes either.
    const subsequentToken = await authConfig.callbacks.jwt?.({
      token: { ...(refreshedToken as object) },
    } as never);

    expect(subsequentToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("ignores a session update whose challenge token is invalid or already consumed", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(false);
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: {
        user: { twoFactorVerified: true, twoFactorChallengeToken: "guessed" },
      },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).toHaveBeenCalledWith(
      "member-1",
      "guessed",
    );
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: false,
        twoFactorVerifiedByChallenge: false,
      }),
    );
  });

  it("verifies the session when the update carries a valid server-minted challenge token", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ twoFactor: true });
    mockConsumeTwoFactorSessionChallenge.mockResolvedValue(true);
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      accessRoles: [{ role: "USER" }],
      forcePasswordChange: false,
      emailVerified: true,
      passwordChangedAt: null,
      twoFactorEnabled: true,
      twoFactorMethod: "EMAIL",
    });

    const refreshedToken = await authConfig.callbacks.jwt?.({
      token: {
        id: "member-1",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionIssuedAt: Date.now(),
      },
      trigger: "update",
      session: {
        user: {
          twoFactorVerified: true,
          twoFactorChallengeToken: "server-minted-token",
        },
      },
    } as never);

    expect(mockConsumeTwoFactorSessionChallenge).toHaveBeenCalledWith(
      "member-1",
      "server-minted-token",
    );
    expect(refreshedToken).toEqual(
      expect.objectContaining({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "EMAIL",
        twoFactorVerified: true,
        twoFactorVerifiedByChallenge: true,
      }),
    );

    // Verification persists across later refreshes of the same session.
    const subsequentToken = await authConfig.callbacks.jwt?.({
      token: { ...(refreshedToken as object) },
    } as never);

    expect(subsequentToken).toEqual(
      expect.objectContaining({
        twoFactorVerified: true,
        twoFactorVerifiedByChallenge: true,
      }),
    );
  });

  it("projects the refreshed token role into the session", async () => {
    const session = await authConfig.callbacks.session?.({
      session: {
        user: {
          id: "member-1",
          email: "admin@example.com",
          name: "Admin User",
          role: "ADMIN",
          accessRoles: ["ADMIN"],
          forcePasswordChange: false,
          isEmailVerified: true,
          sessionInvalidated: false,
        },
      },
      token: {
        id: "member-1",
        role: "MEMBER",
        accessRoles: ["USER"],
        forcePasswordChange: true,
        isEmailVerified: true,
        sessionInvalidated: true,
      },
    } as never);

    expect(session?.user).toEqual({
      id: "member-1",
      email: "admin@example.com",
      name: "Admin User",
      role: "MEMBER",
      accessRoles: ["USER"],
      forcePasswordChange: true,
      isEmailVerified: true,
      sessionInvalidated: true,
      twoFactorRequired: false,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
    });
  });

  it("returns null when the shared auth helper sees an invalidated session", async () => {
    mockRawAuth.mockResolvedValue({
      user: {
        id: "member-1",
        email: "member@example.com",
        name: "Member User",
        role: "MEMBER",
        forcePasswordChange: false,
        isEmailVerified: true,
        sessionInvalidated: true,
      },
    });

    await expect(auth()).resolves.toBeNull();
  });

  it("records lastLoginAt on a successful credentials sign-in", async () => {
    mockFindFirst.mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      firstName: "Member",
      lastName: "User",
      role: "MEMBER",
      active: true,
      canLogin: true,
      passwordHash: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      forcePasswordChange: false,
      emailVerified: true,
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });
    mockUpdate.mockResolvedValue({ id: "member-1" });

    const credentialsProvider = authConfig.providers[0] as {
      authorize: (credentials: Record<string, string>) => Promise<unknown>;
    };

    const user = await credentialsProvider.authorize({
      email: "member@example.com",
      password: "password",
    });

    expect(user).toEqual(
      expect.objectContaining({
        id: "member-1",
        email: "member@example.com",
        role: "MEMBER",
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
  });
});
