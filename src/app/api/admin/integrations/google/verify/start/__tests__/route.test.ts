import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// verify-start (#2087): Full-Admin-only; refuses until both credentials are
// stored + readable; sets the signed verify-intent cookie for the OAuth
// round-trip. Never records verification (that needs the round-trip).
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  getGoogleSetupState: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/google-config", () => ({
  getGoogleSetupState: mocks.getGoogleSetupState,
}));
vi.mock("@/lib/google-oauth", () => ({
  GOOGLE_VERIFY_INTENT_COOKIE: "acb.google_verify_intent",
  GOOGLE_VERIFY_INTENT_TTL_SECONDS: 300,
  buildGoogleVerifyIntentValue: (memberId: string) => `signed:${memberId}`,
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { POST } from "../route";

function asAdmin(fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: fullAdmin ? ["ADMIN"] : [] } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/integrations/google/verify/start", () => {
  it("refuses a non-Full-Admin (403)", async () => {
    asAdmin(false);
    const res = await POST();
    expect(res.status).toBe(403);
  });

  it("refuses when credentials are not both stored (400)", async () => {
    asAdmin(true);
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: false,
      needsReentry: false,
      verified: false,
    });
    const res = await POST();
    expect(res.status).toBe(400);
  });

  it("refuses when stored credentials need re-entry (400)", async () => {
    asAdmin(true);
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: true,
      needsReentry: true,
      verified: false,
    });
    const res = await POST();
    expect(res.status).toBe(400);
  });

  it("sets the signed verify-intent cookie on the happy path", async () => {
    asAdmin(true);
    mocks.getGoogleSetupState.mockResolvedValue({
      clientIdSet: true,
      clientSecretSet: true,
      needsReentry: false,
      verified: false,
    });
    const res = await POST();
    expect(res.status).toBe(200);
    const cookie = res.cookies.get("acb.google_verify_intent");
    expect(cookie?.value).toBe("signed:admin-1");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
  });
});
