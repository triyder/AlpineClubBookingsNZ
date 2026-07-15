import type { FeatureFlags, FeatureFlagKey } from "./schema";

interface FeatureRouteRule {
  flag: FeatureFlagKey;
  prefixes?: string[];
  patterns?: RegExp[];
}

// test seam
export const FEATURE_ROUTE_RULES: FeatureRouteRule[] = [
  {
    flag: "kiosk",
    prefixes: ["/admin/lodge", "/api/admin/lodge", "/lodge", "/api/lodge"],
  },
  {
    flag: "chores",
    prefixes: [
      "/admin/chores",
      "/admin/roster",
      "/api/admin/chores",
      "/api/admin/roster",
      "/api/chores",
      "/lodge/roster",
      "/api/lodge/roster",
    ],
  },
  {
    flag: "financeDashboard",
    prefixes: [
      "/finance",
      "/api/finance",
      "/api/admin/setup/finance-report-mappings",
    ],
  },
  {
    flag: "waitlist",
    prefixes: ["/admin/waitlist", "/api/admin/waitlist"],
    patterns: [
      /^\/api\/bookings\/[^/]+\/waitlist-confirm$/,
      /^\/api\/admin\/bookings\/[^/]+\/force-confirm$/,
    ],
  },
  {
    flag: "xeroIntegration",
    prefixes: [
      "/admin/integrations",
      "/admin/xero",
      "/admin/internet-banking",
      "/api/admin/xero",
      "/api/admin/internet-banking-settings",
      "/api/cron/xero",
      "/api/webhooks/xero",
    ],
    patterns: [
      /^\/api\/admin\/members\/[^/]+\/xero-(link|push|unlink)$/,
    ],
  },
  {
    flag: "bedAllocation",
    prefixes: [
      "/admin/bed-allocation",
      "/admin/rooms-beds",
      "/api/admin/bed-allocation",
    ],
  },
  {
    flag: "internetBankingPayments",
    prefixes: [
      "/admin/internet-banking",
      "/api/admin/internet-banking-settings",
    ],
  },
  {
    flag: "addressAutocomplete",
    prefixes: ["/api/address-autocomplete"],
  },
  {
    flag: "groupBookings",
    prefixes: ["/api/group-bookings"],
  },
  {
    flag: "lockers",
    prefixes: ["/admin/lockers", "/api/admin/lockers"],
  },
  {
    flag: "induction",
    prefixes: [
      "/admin/induction",
      "/induction",
      "/api/admin/inductions",
      "/api/admin/induction-templates",
      "/api/inductions",
    ],
  },
  {
    flag: "workParties",
    prefixes: [
      "/admin/work-parties",
      "/api/admin/work-parties",
      "/api/work-parties",
    ],
  },
  {
    flag: "promoCodes",
    prefixes: [
      "/admin/promo-codes",
      "/api/admin/promo-codes",
      "/api/promo-codes",
    ],
  },
  {
    flag: "hutLeaders",
    prefixes: ["/admin/hut-leaders", "/api/admin/hut-leaders"],
  },
  {
    flag: "communications",
    prefixes: ["/admin/communications", "/api/admin/communications"],
  },
  {
    flag: "skifieldConditions",
    prefixes: [
      "/admin/mountain-conditions",
      "/api/admin/mountain-conditions",
      "/api/skifield-whakapapa",
      "/api/skifield-conditions",
    ],
  },
  {
    // Deliberately OUTSIDE /lodge and /api/lodge: those prefixes are gated by
    // the kiosk flag, and the display module must work without the kiosk
    // (ADR-001 §1, docs/lobby-display/decisions/).
    flag: "lobbyDisplay",
    prefixes: ["/display", "/api/display", "/admin/display", "/api/admin/display"],
  },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function getRequiredFeaturesForPath(pathname: string): FeatureFlagKey[] {
  const required = new Set<FeatureFlagKey>();

  for (const rule of FEATURE_ROUTE_RULES) {
    const prefixMatch = rule.prefixes?.some((prefix) =>
      matchesPrefix(pathname, prefix)
    );
    const patternMatch = rule.patterns?.some((pattern) =>
      pattern.test(pathname)
    );

    if (prefixMatch || patternMatch) {
      required.add(rule.flag);
    }
  }

  return [...required];
}

export function getDisabledFeatureForPath(
  pathname: string,
  flags: FeatureFlags
): FeatureFlagKey | null {
  return getRequiredFeaturesForPath(pathname).find((flag) => !flags[flag]) ?? null;
}

export function isFeatureHrefVisible(
  href: string,
  flags: FeatureFlags
): boolean {
  const pathname = href.startsWith("http")
    ? new URL(href).pathname
    : href.split(/[?#]/)[0] || "/";

  return getDisabledFeatureForPath(pathname, flags) === null;
}
