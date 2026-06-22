import { NextResponse, type NextRequest } from "next/server";
import { featureFlags } from "./config/features";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
} from "./config/feature-routes";
import type { FeatureFlags } from "./config/schema";
import { loadEffectiveModuleFlags } from "./lib/module-settings";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  setSecurityHeaders,
} from "./lib/csp";

export function getFeatureFlagBlockResponse(
  pathname: string,
  flags: FeatureFlags = featureFlags,
): NextResponse | null {
  const disabledFeature = getDisabledFeatureForPath(pathname, flags);

  if (!disabledFeature) {
    return null;
  }

  return pathname.startsWith("/api/")
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : new NextResponse(null, { status: 404 });
}

async function getEffectiveModuleBlockResponse(pathname: string) {
  if (getRequiredFeaturesForPath(pathname).length === 0) {
    return null;
  }

  const effectiveFlags = await loadEffectiveModuleFlags();
  return getFeatureFlagBlockResponse(pathname, effectiveFlags);
}

export async function proxy(request: NextRequest) {
  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy(nonce);
  const pageSlug =
    request.nextUrl.pathname === "/"
      ? "home"
      : request.nextUrl.pathname.replace(/^\//, "");
  const featureFlagBlockResponse = await getEffectiveModuleBlockResponse(
    request.nextUrl.pathname,
  );

  if (featureFlagBlockResponse) {
    featureFlagBlockResponse.headers.set(CSP_HEADER, csp);
    setSecurityHeaders(featureFlagBlockResponse.headers);
    return featureFlagBlockResponse;
  }

  const requestHeaders = new Headers(request.headers);

  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);
  requestHeaders.set("x-page-slug", pageSlug);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(CSP_HEADER, csp);
  setSecurityHeaders(response.headers);

  return response;
}

export default proxy;

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|logo.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    "/api/admin/bed-allocation/:path*",
    "/api/admin/chores/:path*",
    "/api/admin/communications/:path*",
    "/api/admin/hut-leaders/:path*",
    "/api/admin/induction-templates/:path*",
    "/api/admin/inductions/:path*",
    "/api/admin/lockers/:path*",
    "/api/admin/lodge/:path*",
    "/api/admin/members/:id/xero-link",
    "/api/admin/members/:id/xero-push",
    "/api/admin/members/:id/xero-unlink",
    "/api/admin/mountain-conditions/:path*",
    "/api/admin/promo-codes/:path*",
    "/api/admin/roster/:path*",
    "/api/admin/waitlist/:path*",
    "/api/admin/work-parties/:path*",
    "/api/admin/xero/:path*",
    "/api/bookings/:id/waitlist-confirm",
    "/api/admin/bookings/:id/force-confirm",
    "/api/chores/:path*",
    "/api/cron/xero",
    "/api/finance/:path*",
    "/api/group-bookings/:path*",
    "/api/inductions/:path*",
    "/api/lodge/:path*",
    "/api/promo-codes/:path*",
    "/api/skifield-conditions/:path*",
    "/api/skifield-whakapapa/:path*",
    "/api/webhooks/xero",
    "/api/work-parties/:path*",
  ],
};
