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
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
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
  expect(scriptSrc).toContain("https://www.googletagmanager.com");
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
    expect(directive(policy, "connect-src")).toContain(
      "https://www.google-analytics.com",
    );
    expect(directive(policy, "connect-src")).toContain(
      "https://*.google-analytics.com",
    );
    expect(directive(policy, "img-src")).toContain(
      "https://www.google-analytics.com",
    );
    // The member-photo crop UI (epic #171) previews the selected file by loading
    // its object URL into an <img>, so the global img-src must allow blob:.
    expect(directive(policy, "img-src")).toContain("blob:");
    expect(directive(policy, "worker-src")).toBe("worker-src 'self' blob:");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  // Issue #161 (ADR-003 residual): admin-authored display HTML/CSS can embed an
  // <img>, and the global img-src otherwise allows any https host — tighten
  // img-src to 'self' data: on /display and the sandboxed preview host only.
  it("tightens img-src to 'self' data: on /display and the sandboxed preview host", () => {
    const displayPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/display",
    });
    const previewHostPolicy = buildContentSecurityPolicy("unit-test-nonce", {
      pathname: "/admin/display/preview",
    });

    expect(directive(displayPolicy, "img-src")).toBe("img-src 'self' data:");
    expect(directive(previewHostPolicy, "img-src")).toBe(
      "img-src 'self' data:",
    );
    // The other /display-only relaxations (frame-ancestors, frame-src) are
    // untouched by this change.
    expect(directive(displayPolicy, "frame-ancestors")).toBe(
      "frame-ancestors 'self'",
    );
    expect(directive(previewHostPolicy, "frame-src")).toContain("'self'");
  });

  it("leaves every non-display route's CSP byte-identical to the pre-#161 policy", () => {
    // A pinned expected policy string — any accidental change to a non-display
    // route's CSP (not just img-src) fails this test, not just a directive-by-
    // directive check.
    const expected =
      "default-src 'self'; " +
      "script-src 'self' 'nonce-unit-test-nonce' https://js.stripe.com https://www.googletagmanager.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com; " +
      "font-src 'self' data:; " +
      "connect-src 'self' https://api.stripe.com https://js.stripe.com https://*.ingest.sentry.io https://www.google-analytics.com https://*.google-analytics.com; " +
      "frame-src https://js.stripe.com https://hooks.stripe.com; " +
      "worker-src 'self' blob:; " +
      "object-src 'none'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'";

    expect(buildContentSecurityPolicy("unit-test-nonce")).toBe(expected);
    expect(
      buildContentSecurityPolicy("unit-test-nonce", { pathname: "/dashboard" }),
    ).toBe(expected);
    expect(
      buildContentSecurityPolicy("unit-test-nonce", {
        pathname: "/admin/display/templates",
      }),
    ).toBe(expected);
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

  it("serves the tightened img-src on real /display and preview-host requests (issue #161)", async () => {
    const displayResponse = await proxy(
      new NextRequest("https://example.org/display"),
    );
    const previewResponse = await proxy(
      new NextRequest("https://example.org/admin/display/preview"),
    );
    const dashboardResponse = await proxy(
      new NextRequest("https://example.org/dashboard"),
    );

    expect(directive(displayResponse.headers.get(CSP_HEADER) as string, "img-src")).toBe(
      "img-src 'self' data:",
    );
    expect(
      directive(previewResponse.headers.get(CSP_HEADER) as string, "img-src"),
    ).toBe("img-src 'self' data:");
    expect(
      directive(dashboardResponse.headers.get(CSP_HEADER) as string, "img-src"),
    ).toBe(
      "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com",
    );
  });

  it("exposes the requested path to server components via a request header", async () => {
    const response = await proxy(
      new NextRequest("https://example.org/dashboard?tab=bookings")
    );

    expect(
      response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)
    ).toBe("/dashboard?tab=bookings");
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
    const bedAllocationResponse = getFeatureFlagBlockResponse(
      "/admin/bed-allocation",
      {
        ...allFeaturesOn,
        bedAllocation: false,
      },
    );

    expect(pageResponse).not.toBeNull();
    expect(apiResponse).not.toBeNull();
    expect(bedAllocationResponse).not.toBeNull();
    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    expect(bedAllocationResponse?.status).toBe(404);
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
    const addyApiResponse = getFeatureFlagBlockResponse(
      "/api/address-autocomplete/search",
      { ...allFeaturesOn, addressAutocomplete: false },
    );

    expect(pageResponse?.status).toBe(404);
    expect(apiResponse?.status).toBe(404);
    expect(groupApiResponse?.status).toBe(404);
    expect(addyApiResponse?.status).toBe(404);
    await expect(addyApiResponse!.json()).resolves.toEqual({
      error: "Not found",
    });
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
      "/api/admin/internet-banking-settings",
      "/api/admin/communications/send",
      "/api/admin/setup/finance-report-mappings/backfill",
      "/api/admin/mountain-conditions",
      "/api/skifield-whakapapa",
      "/api/skifield-conditions",
      "/api/address-autocomplete/search",
      "/api/address-autocomplete/details/123",
    ];

    for (const url of childApiPaths) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url }),
        `middleware matcher must run for ${url} (gated API route)`,
      ).toBe(true);
    }
  });
});
