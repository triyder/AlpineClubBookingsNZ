import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMockXeroConsentUrl,
  getXeroMockApiOrigin,
  isXeroMockActive,
} from "@/lib/xero-mock-endpoint";

// The mock-Xero harness (#2080) MUST be production-inert: with no
// XERO_MOCK_API_ORIGIN set (every real deployment), the seam contributes
// nothing. These pins are the review criterion for that.
describe("xero-mock-endpoint production inertness", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;
  const originalNextAuth = process.env.NEXTAUTH_URL;

  beforeEach(() => {
    delete process.env.XERO_MOCK_API_ORIGIN;
    process.env.NEXTAUTH_URL = "https://club.example.org";
  });
  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
    if (originalNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuth;
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
});
