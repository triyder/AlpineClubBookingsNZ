import { beforeEach, describe, expect, it, vi } from "vitest";

// Google OAuth wiring in authConfig (#2035): the signIn callback gates + routes
// every Google round-trip (login vs profile-initiated link), applies the fresh
// module kill-switch, refuses unlinked/ineligible members with friendly redirects,
// and NEVER provisions. The provider profile() delegates to the sub-only resolver.
const {
  mockResolveGoogleProfile,
  mockReadGoogleLinkIntent,
  mockLinkGoogleAccount,
  mockLoadEffectiveModuleFlags,
  mockMemberUpdate,
  mockNextAuthAuth,
  mockNextAuth,
} = vi.hoisted(() => {
  // nextAuth.auth() — what the module-local auth() wrapper delegates to; the
  // signIn link branch reads the CURRENT session through it.
  const mockNextAuthAuth = vi.fn();
  return {
    mockResolveGoogleProfile: vi.fn(),
    mockReadGoogleLinkIntent: vi.fn(),
    mockLinkGoogleAccount: vi.fn(),
    mockLoadEffectiveModuleFlags: vi.fn(),
    mockMemberUpdate: vi.fn(),
    mockNextAuthAuth,
    mockNextAuth: vi.fn(() => ({
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: mockNextAuthAuth,
      unstable_update: vi.fn(),
    })),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: mockMemberUpdate,
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

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((config) => ({ id: "google", type: "oidc", ...config })),
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true) },
}));

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "CREDENTIALS_SIGNIN";
  }
  return { default: mockNextAuth, CredentialsSignin };
});

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mockLoadEffectiveModuleFlags,
}));

vi.mock("@/lib/two-factor", () => ({
  consumeTwoFactorSessionChallenge: vi.fn(),
}));

vi.mock("@/lib/google-oauth", () => ({
  resolveGoogleProfile: mockResolveGoogleProfile,
  readGoogleLinkIntent: mockReadGoogleLinkIntent,
  linkGoogleAccount: mockLinkGoogleAccount,
}));

import { authConfig } from "@/lib/auth";

type SignIn = (params: {
  user?: unknown;
  account?: unknown;
  profile?: unknown;
}) => Promise<boolean | string>;

const signIn = authConfig.callbacks!.signIn as unknown as SignIn;

const googleAccount = { provider: "google" };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: true });
  mockReadGoogleLinkIntent.mockResolvedValue(null);
  mockMemberUpdate.mockResolvedValue({});
  // Default: the current session belongs to the member the intent names (the
  // legitimate link flow). Negative cases override this.
  mockNextAuthAuth.mockResolvedValue({ user: { id: "member-1" } });
});

describe("authConfig Google provider wiring", () => {
  it("registers Google as providers[2] with a profile() delegating to the resolver", async () => {
    const provider = authConfig.providers[2] as unknown as {
      id: string;
      profile: (p: unknown) => Promise<unknown>;
    };
    expect(provider.id).toBe("google");

    mockResolveGoogleProfile.mockResolvedValue({ id: "member-1", googleLoginStatus: "ok" });
    const result = await provider.profile({ sub: "s", email: "e" });
    expect(mockResolveGoogleProfile).toHaveBeenCalledWith({ sub: "s", email: "e" });
    expect(result).toEqual({ id: "member-1", googleLoginStatus: "ok" });
  });
});

describe("signIn callback — non-Google", () => {
  it("allows credentials/magic-link untouched", async () => {
    expect(await signIn({ account: { provider: "credentials" } })).toBe(true);
    expect(await signIn({ account: { provider: "magic-link" } })).toBe(true);
    expect(mockLoadEffectiveModuleFlags).not.toHaveBeenCalled();
  });
});

describe("signIn callback — module kill-switch", () => {
  it("refuses a Google LOGIN when the module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    const result = await signIn({
      user: { id: "member-1", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_disabled");
    // Even a fully-eligible linked member is refused → no session, no login bump.
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a LINK round-trip when the module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    const result = await signIn({
      account: googleAccount,
      profile: { sub: "s", email_verified: true },
    });
    expect(result).toBe("/profile?googleError=disabled#security");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });
});

describe("signIn callback — LOGIN path (sub-only)", () => {
  it("allows an eligible member and records the login timestamp", async () => {
    const result = await signIn({
      user: { id: "member-1", googleLoginStatus: "ok" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe(true);
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { lastLoginAt: expect.any(Date) },
    });
  });

  it("refuses an unlinked account (email-match takeover regression) with a friendly redirect", async () => {
    const result = await signIn({
      user: { id: "google-oauth:s", googleLoginStatus: "unlinked" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_unlinked");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a forcePasswordChange member", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "password_change" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_password_change");
  });

  it("refuses an archived/dependent member with the generic refused message", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "refused" },
      account: googleAccount,
      profile: { sub: "s" },
    });
    expect(result).toBe("/login?error=google_refused");
  });

  it("refuses when the profile carries no sub", async () => {
    const result = await signIn({
      user: { id: "x", googleLoginStatus: "failed" },
      account: googleAccount,
      profile: {},
    });
    expect(result).toBe("/login?error=google_failed");
  });
});

describe("signIn callback — LINK path (profile-initiated)", () => {
  it("links when intent + verified email are present, returning a redirect (no session mint)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockLinkGoogleAccount.mockResolvedValue("googleLinked=1");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(mockLinkGoogleAccount).toHaveBeenCalledWith("member-1", "sub-1");
    expect(result).toBe("/profile?googleLinked=1#security");
    // A string return makes @auth/core redirect BEFORE minting a session.
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("refuses linking when the Google email is not verified", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: false },
    });

    expect(result).toBe("/profile?googleError=unverified#security");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("surfaces a sub-already-linked-to-another-member refusal from the link write", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockLinkGoogleAccount.mockResolvedValue("googleError=already_linked");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(result).toBe("/profile?googleError=already_linked#security");
  });

  it("REFUSES a stale intent when a DIFFERENT member holds the session (shared-device takeover regression)", async () => {
    // Member V abandoned a link; within the TTL member W logs in via Google on
    // the same device. The intent still names V, but the session is W — must NOT
    // link V to W's sub, and must NOT mutate anything.
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-V" });
    mockNextAuthAuth.mockResolvedValue({ user: { id: "member-W" } });

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-W", email_verified: true },
    });

    expect(result).toBe("/login?error=google_refused");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("REFUSES a stale intent when there is NO current session (falls through cleanly)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-V" });
    mockNextAuthAuth.mockResolvedValue(null);

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(result).toBe("/login?error=google_refused");
    expect(mockLinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("links when the session matches the intent (legitimate flow, non-breaking)", async () => {
    mockReadGoogleLinkIntent.mockResolvedValue({ memberId: "member-1" });
    mockNextAuthAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockLinkGoogleAccount.mockResolvedValue("googleLinked=1");

    const result = await signIn({
      account: googleAccount,
      profile: { sub: "sub-1", email_verified: true },
    });

    expect(mockLinkGoogleAccount).toHaveBeenCalledWith("member-1", "sub-1");
    expect(result).toBe("/profile?googleLinked=1#security");
  });
});
