import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  unstable_doesMiddlewareMatch as unstable_doesProxyMatch,
} from "next/experimental/testing/server";
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  CSP_REPORT_ONLY_HEADER,
  SECURITY_HEADERS,
} from "@/lib/csp";
import { FEATURE_ROUTE_RULES } from "@/config/feature-routes";
import { MODULE_KEYS } from "@/config/modules";
import proxy, { config, getFeatureFlagBlockResponse } from "../../proxy";
import type { FeatureFlags } from "@/config/schema";

const allFeaturesOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function directive(policy: string, name: string) {
  const match = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

  expect(match).toBeDefined();
  return match as string;
}

function nonceFromScriptSrc(policy: string) {
  return directive(policy, "script-src").match(/'nonce-([^']+)'/)?.[1];
}

function expectStrictScriptSrc(policy: string) {
  const scriptSrc = directive(policy, "script-src");

  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://js.stripe.com");
  expect(scriptSrc).not.toContain("https://api-nz.addysolutions.com");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(nonceFromScriptSrc(policy)).toMatch(/^[A-Za-z0-9+/=]+$/);
}

describe("CSP policy", () => {
  it("builds a script-src with a nonce and without unsafe-inline", () => {
    const policy = buildContentSecurityPolicy("unit-test-nonce");

    expect(directive(policy, "script-src")).toContain(
      "'nonce-unit-test-nonce'"
    );
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
    expect(directive(policy, "worker-src")).toBe("worker-src 'self' blob:");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});

describe("CSP proxy", () => {
  it("matches root page requests but skips API/static/prefetch requests", () => {
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/",
      })
    ).toBe(true);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/api/health",
      })
    ).toBe(false);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/api/admin/waitlist",
      })
    ).toBe(true);
    expect(
      unstable_doesProxyMatch({
        config,
        nextConfig: {},
        url: "/_next/static/chunks/app.js",
      })
    ).toBe(false);
    expect(
      unstable_doesProxyMatch({
        config,
        headers: { purpose: "prefetch" },
        nextConfig: {},
        url: "/",
      })
    ).toBe(false);
  });

  it("emits a single enforced CSP header with a per-request nonce and no report-only header", async () => {
    const response = await proxy(new NextRequest("https://example.org/"));
    const enforcedPolicy = response.headers.get(CSP_HEADER);

    expect(enforcedPolicy).toBeTruthy();
    expect(response.headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    expectStrictScriptSrc(enforcedPolicy as string);

    const nonce = nonceFromScriptSrc(enforcedPolicy as string);
    expect(nonce).toBeTruthy();
    expect(response.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(
      nonce
    );
    expect(
      response.headers.get(`x-middleware-request-${CSP_HEADER.toLowerCase()}`)
    ).toBe(enforcedPolicy);

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("generates a different nonce per request", async () => {
    const a = await proxy(new NextRequest("https://example.org/"));
    const b = await proxy(new NextRequest("https://example.org/"));
    const nonceA = nonceFromScriptSrc(a.headers.get(CSP_HEADER) as string);
    const nonceB = nonceFromScriptSrc(b.headers.get(CSP_HEADER) as string);

    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toEqual(nonceB);
  });

  it("returns 404 for disabled feature page and API paths", async () => {
    const pageResponse = getFeatureFlagBlockResponse("/admin/waitlist", {
      ...allFeaturesOn,
      waitlist: false,
    });
    const apiResponse = getFeatureFlagBlockResponse("/api/admin/waitlist", {
      ...allFeaturesOn,
      waitlist: false,
    });

    expect(pageResponse).not.toBeNull();
    expect(apiResponse).not.toBeNull();
    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    await expect(apiResponse!.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 404 for a disabled new-module page and its API route", async () => {
    // The page AND the backend API must both 404 when the module is off.
    const pageResponse = getFeatureFlagBlockResponse("/admin/lockers", {
      ...allFeaturesOn,
      lockers: false,
    });
    const apiResponse = getFeatureFlagBlockResponse("/api/admin/lockers", {
      ...allFeaturesOn,
      lockers: false,
    });
    const groupApiResponse = getFeatureFlagBlockResponse(
      "/api/group-bookings/abc/join",
      { ...allFeaturesOn, groupBookings: false },
    );

    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    expect(groupApiResponse?.status).toBe(404);
  });

  // Regression guard: every feature-gated route must actually be covered by the
  // middleware matcher, or the proxy never runs and the 404 gate above is dead
  // code for that route. (An earlier bug shipped feature-routes rules for new
  // modules whose /api paths were missing from the matcher, so disabled modules
  // still served their backend.)
  it("matcher runs for every feature-gated route prefix", () => {
    const gatedPrefixes = FEATURE_ROUTE_RULES.flatMap(
      (rule) => rule.prefixes ?? [],
    );

    for (const prefix of gatedPrefixes) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url: prefix }),
        `middleware matcher must run for ${prefix} (feature-gated route)`,
      ).toBe(true);
    }
  });

  it("matcher runs for the new modules' child API paths", () => {
    // The real routes live under these prefixes (e.g. /[id], /[code]), so the
    // matcher must cover the children too — not just the bare prefix.
    const childApiPaths = [
      "/api/group-bookings/CODE/join",
      "/api/admin/lockers/123",
      "/api/admin/inductions/123",
      "/api/admin/induction-templates/123",
      "/api/inductions/123",
      "/api/admin/work-parties/123",
      "/api/work-parties/active",
      "/api/admin/promo-codes/123",
      "/api/promo-codes/validate",
      "/api/admin/hut-leaders/123",
      "/api/admin/communications/send",
      "/api/admin/mountain-conditions",
      "/api/skifield-whakapapa",
      "/api/skifield-conditions",
    ];

    for (const url of childApiPaths) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url }),
        `middleware matcher must run for ${url} (gated API route)`,
      ).toBe(true);
    }
  });
});
