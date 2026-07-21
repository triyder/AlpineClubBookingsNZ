import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMockXeroConsentUrl,
  getXeroMockApiOrigin,
  getXeroMockInternalOrigin,
  isRealProductionRuntime,
  isXeroMockActive,
} from "@/lib/xero-mock-endpoint";

// The mock-Xero harness (#2080) MUST be production-inert: with no
// XERO_MOCK_API_ORIGIN set (every real deployment), the seam contributes
// nothing. These pins are the review criterion for that.
describe("xero-mock-endpoint production inertness", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;
  const originalNextAuth = process.env.NEXTAUTH_URL;
  const originalRuntimeRole = process.env.APP_RUNTIME_ROLE;

  beforeEach(() => {
    delete process.env.XERO_MOCK_API_ORIGIN;
    process.env.NEXTAUTH_URL = "https://club.example.org";
  });
  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
    if (originalNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuth;
    vi.unstubAllEnvs();
    if (originalRuntimeRole === undefined) delete process.env.APP_RUNTIME_ROLE;
    else process.env.APP_RUNTIME_ROLE = originalRuntimeRole;
  });

  it("is inactive when the env var is unset", () => {
    expect(getXeroMockApiOrigin()).toBeUndefined();
    expect(isXeroMockActive()).toBe(false);
  });

  it("is inactive for a blank env var", () => {
    process.env.XERO_MOCK_API_ORIGIN = "   ";
    expect(getXeroMockApiOrigin()).toBeUndefined();
    expect(isXeroMockActive()).toBe(false);
  });

  it("activates and builds a consent URL pointing at the gated mock authorize endpoint", () => {
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    expect(isXeroMockActive()).toBe(true);

    const url = buildMockXeroConsentUrl("http://localhost:3000", "state-123");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:3000");
    expect(parsed.pathname).toBe("/api/testing/xero-mock/authorize");
    expect(parsed.searchParams.get("state")).toBe("state-123");
    // The redirect_uri is the app's real callback derived from NEXTAUTH_URL.
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://club.example.org/api/admin/xero/callback",
    );
  });

  // CORRECTNESS-F2 backstop: even if XERO_MOCK_API_ORIGIN somehow leaked into a
  // real production runtime, the mock stays inert. "Real production" = a
  // production build whose runtime role is NOT the E2E staging harness.
  it("stays inert in a real production runtime even with the origin set", () => {
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "production");
    process.env.APP_RUNTIME_ROLE = "web-blue";

    expect(isRealProductionRuntime()).toBe(true);
    expect(getXeroMockApiOrigin()).toBeUndefined();
    expect(isXeroMockActive()).toBe(false);
  });

  it("stays inert in a production build with no runtime role set", () => {
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.APP_RUNTIME_ROLE;

    expect(getXeroMockApiOrigin()).toBeUndefined();
    expect(isXeroMockActive()).toBe(false);
  });

  it("stays ACTIVE for the E2E staging stack (production build, staging role)", () => {
    // The E2E stack legitimately runs the production build with the mock on;
    // APP_RUNTIME_ROLE=staging distinguishes it from a real deployment.
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "production");
    process.env.APP_RUNTIME_ROLE = "staging";

    expect(isRealProductionRuntime()).toBe(false);
    expect(getXeroMockApiOrigin()).toBe("http://localhost:3000");
    expect(isXeroMockActive()).toBe(true);
  });

  it("is active for a non-production runtime with the origin set", () => {
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.APP_RUNTIME_ROLE;

    expect(isRealProductionRuntime()).toBe(false);
    expect(isXeroMockActive()).toBe(true);
  });

  it("internal origin follows the same gate and falls back to the public origin", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.APP_RUNTIME_ROLE;
    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;

    // Inert whenever the mock as a whole is inert — even with INTERNAL set.
    delete process.env.XERO_MOCK_API_ORIGIN;
    process.env.XERO_MOCK_INTERNAL_ORIGIN = "http://127.0.0.1:3000";
    expect(getXeroMockInternalOrigin()).toBeUndefined();

    // Falls back to the public origin when INTERNAL is unset.
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3001";
    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    expect(getXeroMockInternalOrigin()).toBe("http://localhost:3001");

    // Uses the dedicated in-container origin when both are set.
    process.env.XERO_MOCK_INTERNAL_ORIGIN = "http://127.0.0.1:3000";
    expect(getXeroMockInternalOrigin()).toBe("http://127.0.0.1:3000");

    // And the real-production backstop kills it like everything else.
    vi.stubEnv("NODE_ENV", "production");
    process.env.APP_RUNTIME_ROLE = "web-green";
    expect(getXeroMockInternalOrigin()).toBeUndefined();

    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
  });
});
