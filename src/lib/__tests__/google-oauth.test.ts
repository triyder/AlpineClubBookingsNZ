import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the Google OAuth linking helpers (#2035): the signed link-intent
// cookie, the sub-only login resolver (no provisioning, no email-match), and the
// audited link/unlink writes with their collision guards.
const {
  mockMemberFindFirst,
  mockMemberFindUnique,
  mockMemberUpdate,
  mockAuditCreate,
  mockCookieStore,
  mockCookies,
} = vi.hoisted(() => {
  const store = {
    get: vi.fn(),
    delete: vi.fn(),
  };
  return {
    mockMemberFindFirst: vi.fn(),
    mockMemberFindUnique: vi.fn(),
    mockMemberUpdate: vi.fn(),
    mockAuditCreate: vi.fn(),
    mockCookieStore: store,
    mockCookies: vi.fn(async () => store),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: mockMemberFindFirst,
      findUnique: mockMemberFindUnique,
      update: mockMemberUpdate,
    },
    auditLog: { create: mockAuditCreate },
  },
}));

vi.mock("next/headers", () => ({
  cookies: mockCookies,
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => "test-secret-value"),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  GOOGLE_LINK_INTENT_COOKIE,
  buildGoogleLinkIntentValue,
  googleCredentialsConfigured,
  linkGoogleAccount,
  readGoogleLinkIntent,
  resolveGoogleProfile,
  unlinkGoogleAccount,
} from "@/lib/google-oauth";

const eligibleMember = {
  id: "member-1",
  email: "member@example.com",
  firstName: "Member",
  lastName: "User",
  role: "MEMBER",
  active: true,
  canLogin: true,
  emailVerified: true,
  forcePasswordChange: false,
  twoFactorEnabled: false,
  twoFactorMethod: null,
  googleSub: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditCreate.mockResolvedValue({});
  mockMemberUpdate.mockResolvedValue({});
  mockCookieStore.get.mockReturnValue(undefined);
});

describe("google link-intent cookie", () => {
  it("round-trips a signed intent bound to the member id", async () => {
    const value = buildGoogleLinkIntentValue("member-1");
    mockCookieStore.get.mockReturnValue({ value });

    const intent = await readGoogleLinkIntent();

    expect(intent).toEqual({ memberId: "member-1" });
    expect(mockCookieStore.get).toHaveBeenCalledWith(GOOGLE_LINK_INTENT_COOKIE);
    // Best-effort single-use clear.
    expect(mockCookieStore.delete).toHaveBeenCalledWith(GOOGLE_LINK_INTENT_COOKIE);
  });

  it("rejects a tampered signature", async () => {
    const value = buildGoogleLinkIntentValue("member-1");
    // Flip the payload but keep the old signature.
    const [, sig] = value.split(".");
    const forged = `${buildGoogleLinkIntentValue("attacker").split(".")[0]}.${sig}`;
    mockCookieStore.get.mockReturnValue({ value: forged });

    expect(await readGoogleLinkIntent()).toBeNull();
  });

  it("rejects an expired intent", async () => {
    vi.useFakeTimers();
    const value = buildGoogleLinkIntentValue("member-1");
    // Advance beyond the TTL.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    mockCookieStore.get.mockReturnValue({ value });

    expect(await readGoogleLinkIntent()).toBeNull();
    vi.useRealTimers();
  });

  it("returns null (no clear) when no cookie is present", async () => {
    expect(await readGoogleLinkIntent()).toBeNull();
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
  });
});

describe("googleCredentialsConfigured", () => {
  it("is true only when both secrets are set", () => {
    const prev = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "id";
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(googleCredentialsConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(googleCredentialsConfigured()).toBe(true);
    process.env = prev;
  });
});

describe("resolveGoogleProfile (sub-only, no provisioning)", () => {
  it("resolves an eligible linked member to the credentials-parity user shape", async () => {
    mockMemberFindFirst.mockResolvedValue(eligibleMember);

    const result = await resolveGoogleProfile({ sub: "google-sub-1", email: "member@example.com" });

    expect(mockMemberFindFirst).toHaveBeenCalledWith({
      where: { googleSub: "google-sub-1", canLogin: true },
    });
    expect(result).toEqual({
      id: "member-1",
      email: "member@example.com",
      name: "Member User",
      role: "MEMBER",
      forcePasswordChange: false,
      isEmailVerified: true,
      twoFactorEnabled: false,
      twoFactorMethod: null,
      googleLoginStatus: "ok",
    });
  });

  it("REFUSES an email-matching account that is not linked (takeover regression)", async () => {
    // No member carries this sub — even though a member with the same email
    // exists, resolution is sub-only, so it returns the unlinked sentinel and
    // NEVER the member. No lookup by email happens at all.
    mockMemberFindFirst.mockResolvedValue(null);

    const result = await resolveGoogleProfile({
      sub: "google-sub-unlinked",
      email: "member@example.com",
    });

    expect(result.googleLoginStatus).toBe("unlinked");
    expect(result.id).not.toBe("member-1");
    // Only ever queried by googleSub, never by email.
    expect(mockMemberFindFirst).toHaveBeenCalledTimes(1);
    expect(mockMemberFindFirst).toHaveBeenCalledWith({
      where: { googleSub: "google-sub-unlinked", canLogin: true },
    });
  });

  it("refuses an archived (inactive) linked member", async () => {
    mockMemberFindFirst.mockResolvedValue({ ...eligibleMember, active: false });
    const result = await resolveGoogleProfile({ sub: "s", email: "e" });
    expect(result.googleLoginStatus).toBe("refused");
  });

  it("refuses an unverified linked member", async () => {
    mockMemberFindFirst.mockResolvedValue({ ...eligibleMember, emailVerified: false });
    const result = await resolveGoogleProfile({ sub: "s", email: "e" });
    expect(result.googleLoginStatus).toBe("refused");
  });

  it("refuses a forcePasswordChange member with the reset-pointer status", async () => {
    mockMemberFindFirst.mockResolvedValue({ ...eligibleMember, forcePasswordChange: true });
    const result = await resolveGoogleProfile({ sub: "s", email: "e" });
    expect(result.googleLoginStatus).toBe("password_change");
  });

  it("returns failed when the profile carries no sub", async () => {
    const result = await resolveGoogleProfile({ email: "e" });
    expect(result.googleLoginStatus).toBe("failed");
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
  });
});

describe("linkGoogleAccount (guards + audit)", () => {
  it("pins the sub and audits a first-time link", async () => {
    mockMemberFindUnique
      .mockResolvedValueOnce(null) // existingBySub
      .mockResolvedValueOnce({ id: "member-1", googleSub: null }); // member

    const outcome = await linkGoogleAccount("member-1", "sub-1");

    expect(outcome).toBe("googleLinked=1");
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { googleSub: "sub-1" },
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a sub already linked to another member (no takeover)", async () => {
    mockMemberFindUnique
      .mockResolvedValueOnce({ id: "member-2" }) // existingBySub -> different member
      .mockResolvedValueOnce({ id: "member-1", googleSub: null });

    const outcome = await linkGoogleAccount("member-1", "sub-1");

    expect(outcome).toBe("googleError=already_linked");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).toHaveBeenCalledTimes(1); // refusal audited
  });

  it("refuses when the member is already linked to a different sub", async () => {
    mockMemberFindUnique
      .mockResolvedValueOnce(null) // existingBySub for the NEW sub
      .mockResolvedValueOnce({ id: "member-1", googleSub: "old-sub" });

    const outcome = await linkGoogleAccount("member-1", "new-sub");

    expect(outcome).toBe("googleError=account_conflict");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent when re-linking the same sub (no write)", async () => {
    mockMemberFindUnique
      .mockResolvedValueOnce({ id: "member-1" })
      .mockResolvedValueOnce({ id: "member-1", googleSub: "sub-1" });

    const outcome = await linkGoogleAccount("member-1", "sub-1");

    expect(outcome).toBe("googleLinked=1");
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });

  it("fails closed to a friendly refusal on a P2002 unique-constraint race", async () => {
    // The reads pass the guards, but between the read and the write another
    // member links the same sub — the googleSub @unique rejects with P2002.
    mockMemberFindUnique
      .mockResolvedValueOnce(null) // existingBySub
      .mockResolvedValueOnce({ id: "member-1", googleSub: null });
    mockMemberUpdate.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const outcome = await linkGoogleAccount("member-1", "sub-1");

    expect(outcome).toBe("googleError=already_linked");
    // The race refusal is audited (blocked), not surfaced as a raw error.
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-P2002 update error (not masked as a link conflict)", async () => {
    mockMemberFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "member-1", googleSub: null });
    mockMemberUpdate.mockRejectedValueOnce(new Error("connection lost"));

    await expect(linkGoogleAccount("member-1", "sub-1")).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("unlinkGoogleAccount", () => {
  it("nulls the sub and audits when linked", async () => {
    mockMemberFindUnique.mockResolvedValue({ googleSub: "sub-1" });

    await unlinkGoogleAccount("member-1");

    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { googleSub: null },
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no write, no audit) when already unlinked", async () => {
    mockMemberFindUnique.mockResolvedValue({ googleSub: null });

    await unlinkGoogleAccount("member-1");

    expect(mockMemberUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});
