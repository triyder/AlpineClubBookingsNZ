import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateSession: vi.fn().mockResolvedValue(null),
  clearTwoFactorLockout: vi.fn().mockResolvedValue(undefined),
  createTwoFactorSessionChallenge: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
  updateSession: mocks.updateSession,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/two-factor", () => ({
  clearTwoFactorLockout: mocks.clearTwoFactorLockout,
  createTwoFactorSessionChallenge: mocks.createTwoFactorSessionChallenge,
  getActiveTwoFactorLockout: vi.fn(() => null),
}));

import { markTwoFactorSessionVerified } from "@/lib/two-factor-api";

describe("markTwoFactorSessionVerified", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTwoFactorSessionChallenge.mockResolvedValue("minted-token");
  });

  it("mints a server-side challenge token and passes it through the session update", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });

    await markTwoFactorSessionVerified();

    expect(mocks.clearTwoFactorLockout).toHaveBeenCalledWith("member-1");
    expect(mocks.createTwoFactorSessionChallenge).toHaveBeenCalledWith(
      "member-1",
    );
    expect(mocks.updateSession).toHaveBeenCalledWith({
      user: {
        twoFactorVerified: true,
        twoFactorChallengeToken: "minted-token",
      },
    });
  });

  it("does not update the session when there is no authenticated member", async () => {
    mocks.auth.mockResolvedValue(null);

    await markTwoFactorSessionVerified();

    expect(mocks.clearTwoFactorLockout).not.toHaveBeenCalled();
    expect(mocks.createTwoFactorSessionChallenge).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});
