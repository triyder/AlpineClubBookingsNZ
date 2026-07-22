import { beforeEach, describe, expect, it, vi } from "vitest";

// Profile-initiated Google linking routes (#2035): the authenticated
// link/start (sets the signed intent cookie only when the module is on + creds
// configured) and unlink (nulls googleSub, audited) endpoints.
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  buildGoogleLinkIntentValue: vi.fn(() => "signed-intent-value"),
  googleCredentialsConfigured: vi.fn(),
  unlinkGoogleAccount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/google-oauth", () => ({
  GOOGLE_LINK_INTENT_COOKIE: "acb.google_link_intent",
  GOOGLE_LINK_INTENT_TTL_SECONDS: 300,
  buildGoogleLinkIntentValue: h.buildGoogleLinkIntentValue,
  googleCredentialsConfigured: h.googleCredentialsConfigured,
  unlinkGoogleAccount: h.unlinkGoogleAccount,
}));

import { POST as startPost } from "@/app/api/profile/google/link/start/route";
import { POST as unlinkPost } from "@/app/api/profile/google/unlink/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "member-1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.loadEffectiveModuleFlags.mockResolvedValue({ googleLogin: true });
  h.googleCredentialsConfigured.mockResolvedValue(true);
});

describe("POST /api/profile/google/link/start", () => {
  it("sets the signed link-intent cookie for an authenticated member", async () => {
    const res = await startPost();
    expect(res.status).toBe(200);
    expect(h.buildGoogleLinkIntentValue).toHaveBeenCalledWith("member-1");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("acb.google_link_intent=signed-intent-value");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
  });

  it("401s an unauthenticated caller", async () => {
    h.auth.mockResolvedValue(null);
    const res = await startPost();
    expect(res.status).toBe(401);
    expect(h.buildGoogleLinkIntentValue).not.toHaveBeenCalled();
  });

  it("403s when the module is off", async () => {
    h.loadEffectiveModuleFlags.mockResolvedValue({ googleLogin: false });
    const res = await startPost();
    expect(res.status).toBe(403);
    expect(h.buildGoogleLinkIntentValue).not.toHaveBeenCalled();
  });

  it("403s when Google credentials are not configured", async () => {
    h.googleCredentialsConfigured.mockResolvedValue(false);
    const res = await startPost();
    expect(res.status).toBe(403);
  });
});

describe("POST /api/profile/google/unlink", () => {
  it("unlinks the authenticated member", async () => {
    const res = await unlinkPost();
    expect(res.status).toBe(200);
    expect(h.unlinkGoogleAccount).toHaveBeenCalledWith("member-1");
  });

  it("401s an unauthenticated caller", async () => {
    h.auth.mockResolvedValue(null);
    const res = await unlinkPost();
    expect(res.status).toBe(401);
    expect(h.unlinkGoogleAccount).not.toHaveBeenCalled();
  });

  it("propagates an inactive-session refusal", async () => {
    const { NextResponse } = await import("next/server");
    h.requireActiveSessionUser.mockResolvedValue(
      NextResponse.json({ error: "Account is deactivated" }, { status: 403 }),
    );
    const res = await unlinkPost();
    expect(res.status).toBe(403);
    expect(h.unlinkGoogleAccount).not.toHaveBeenCalled();
  });
});
