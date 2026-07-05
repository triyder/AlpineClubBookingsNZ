import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAdminRouteRequirement,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import { FEATURE_ROUTE_RULES } from "@/config/feature-routes";

// ---------------------------------------------------------------------------
// Admin route-map drift guard (issue #1322).
//
// Two central maps decide how an admin page or /api/admin route is protected:
//
//   1. Permission-area map — getAdminRouteRequirement() in admin-permissions.ts
//      (backed by ROUTE_AREA_PREFIXES + SPECIAL_ROUTE_AREA_PATTERNS). It maps a
//      pathname to an admin permission area (bookings, finance, membership, …).
//      Its LAST entry, `overview`, uses the prefixes "/admin" and "/api/admin",
//      so it is a CATCH-ALL: every admin route resolves to *something*, and any
//      route that does not match a more specific area silently lands on
//      `overview`. A finance-sensitive route that forgets its "/api/admin/…"
//      prefix would therefore be readable by anyone with plain overview access
//      instead of finance access.
//
//   2. Feature-route map — FEATURE_ROUTE_RULES in config/feature-routes.ts. It
//      gates optional modules (bedAllocation, waitlist, xeroIntegration, …) so
//      an off module 404s both its pages and its API routes.
//
// These tests fail the build when a NEW admin page/route lands in the overview
// catch-all without being intentionally allowlisted, and when a feature-route
// prefix stops matching any real file (a rename silently dropping a gate).
//
// WHAT THIS GUARD DOES AND DOES NOT CATCH
//   Catches:      an UNMAPPED admin route (falls to the overview catch-all).
//   Does NOT catch: a MIS-mapped route that inherits an existing, wrong prefix.
//     e.g. a new finance-only action added under "/api/admin/members/[id]/…"
//     silently inherits the `membership` area and passes here. That is inherent
//     to a prefix map; when adding a sensitive action under an existing prefix,
//     still add a SPECIAL_ROUTE_AREA_PATTERNS entry by hand. The guarantee here
//     is narrower: "nothing lands in the overview catch-all unnoticed."
// ---------------------------------------------------------------------------

function walkFiles(dir: string, leaf: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath, leaf);
    return entry.name === leaf ? [entryPath] : [];
  });
}

// Turn an app-router file path into the URL pathname the route maps resolve.
// Route groups like "(admin)" are stripped, and dynamic segments ("[id]",
// "[...slug]") are substituted with a concrete placeholder so prefix and
// pattern (e.g. [^/]+) matching behaves like a real request.
function toPathname(absFile: string): string {
  const rel = path.relative(path.join(process.cwd(), "src/app"), absFile);
  const parts = rel.split(path.sep);
  parts.pop(); // drop the page.tsx / route.ts leaf
  const segments = parts
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .map((seg) => (/^\[.*\]$/.test(seg) ? "sample" : seg));
  return `/${segments.join("/")}`;
}

function relative(absFile: string): string {
  return path.relative(process.cwd(), absFile).split(path.sep).join("/");
}

const adminPageFiles = walkFiles(
  path.join(process.cwd(), "src/app/(admin)"),
  "page.tsx",
).sort();
const adminApiFiles = walkFiles(
  path.join(process.cwd(), "src/app/api/admin"),
  "route.ts",
).sort();

type AdminRoute = { file: string; rel: string; pathname: string };

const adminRoutes: AdminRoute[] = [...adminPageFiles, ...adminApiFiles].map(
  (file) => ({ file, rel: relative(file), pathname: toPathname(file) }),
);

// ---------------------------------------------------------------------------
// EXPLICIT overview allowlist.
//
// Small, named, and justified: each route below intentionally resolves to the
// `overview` catch-all and needs no more specific permission area. Keyed by the
// concrete pathname the resolver sees. Adding an entry here is the deliberate
// "this route belongs to overview" escape hatch — see the failure message on
// the coverage test for the three ways to satisfy it.
// ---------------------------------------------------------------------------
const OVERVIEW_ALLOWLIST: Record<string, string> = {
  // The admin landing dashboard. It is the cross-area entry point and is what
  // getFirstAccessibleAdminHref() sends any admin with overview access to;
  // overview (view) is exactly the right requirement.
  "/admin/dashboard":
    "Admin landing dashboard — cross-area entry point; overview view is correct.",
  // Read-only aggregate counts (pending applications, bookings, refunds, …) that
  // drive the sidebar badges. It spans every area by design, so it is gated at
  // the overview level rather than any single area; each underlying detail route
  // enforces its own area on drill-in.
  "/api/admin/pending-counts":
    "Cross-area read-only badge counts for the sidebar; spans all areas, so overview view is correct.",
};

// State-changing GET endpoints (EDIT_ON_GET_PREFIXES in admin-permissions.ts).
// These are OAuth browser-redirect handlers exported as GET but which mutate
// server state (token exchange / connection start), so they must demand `edit`
// even though GET normally maps to `view`. Enumerated here so a new
// side-effecting GET is a conscious, reviewed addition.
const STATE_CHANGING_GET_ROUTES = [
  "/api/admin/xero/callback",
  "/api/admin/xero/connect",
] as const;

describe("admin route-map drift guard (#1322)", () => {
  it("finds admin pages and API routes to enumerate", () => {
    // Sanity floor so a broken walk (wrong dir, zero matches) can never make
    // the coverage assertions vacuously pass.
    expect(adminPageFiles.length).toBeGreaterThan(40);
    expect(adminApiFiles.length).toBeGreaterThan(100);
  });

  it("maps every admin page and /api/admin route to a specific area or an allowlisted overview route", () => {
    const violations = adminRoutes.flatMap(({ rel, pathname }) => {
      const requirement = getAdminRouteRequirement(pathname, "GET");

      // The overview catch-all means this is only null if a future change
      // removes it; treat that as a hard failure too.
      if (!requirement) {
        return [`${rel} (${pathname}): resolves to NO admin requirement`];
      }

      const area: AdminPermissionArea = requirement.area;
      const allowlisted = pathname in OVERVIEW_ALLOWLIST;

      if (area === "overview" && !allowlisted) {
        return [
          `${rel} (${pathname}): lands on the overview catch-all. Fix one of:\n` +
            `    - add its prefix to ROUTE_AREA_PREFIXES for the correct area (admin-permissions.ts), or\n` +
            `    - add a SPECIAL_ROUTE_AREA_PATTERNS entry if it needs a different area than its prefix, or\n` +
            `    - add it to OVERVIEW_ALLOWLIST in this test with a one-line justification.`,
        ];
      }

      return [];
    });

    expect(violations).toEqual([]);
  });

  it("keeps the overview allowlist free of stale or over-scoped entries", () => {
    const onDisk = new Set(adminRoutes.map((r) => r.pathname));

    const violations = Object.keys(OVERVIEW_ALLOWLIST).flatMap((pathname) => {
      if (!onDisk.has(pathname)) {
        return [
          `${pathname}: allowlisted route no longer exists on disk — remove the entry.`,
        ];
      }
      const requirement = getAdminRouteRequirement(pathname, "GET");
      if (requirement && requirement.area !== "overview") {
        return [
          `${pathname}: now resolves to "${requirement.area}", not overview — remove the (redundant) allowlist entry.`,
        ];
      }
      return [];
    });

    expect(violations).toEqual([]);
  });

  it("forces edit access on the enumerated state-changing GET endpoints", () => {
    const violations = STATE_CHANGING_GET_ROUTES.flatMap((pathname) => {
      const requirement = getAdminRouteRequirement(pathname, "GET");
      if (!requirement) {
        return [`${pathname}: expected an admin requirement, got none`];
      }
      return requirement.level === "edit"
        ? []
        : [
            `${pathname}: side-effecting GET must require edit, got "${requirement.level}"`,
          ];
    });

    // Every enumerated route must exist on disk so the list cannot rot.
    const onDisk = new Set(adminRoutes.map((r) => r.pathname));
    for (const pathname of STATE_CHANGING_GET_ROUTES) {
      if (!onDisk.has(pathname)) {
        violations.push(`${pathname}: enumerated route file is missing`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps every admin feature-route prefix pointing at at least one real file", () => {
    // A feature-route prefix that no longer matches any file is a silent gate
    // drop: the module toggle stops covering the renamed/moved route. Only the
    // admin-scoped prefixes are checked here (the non-admin surface is out of
    // this test's enumeration scope and covered by feature-routes.test.ts).
    const adminPathnames = adminRoutes.map((r) => r.pathname);
    const isAdminPrefix = (prefix: string) =>
      prefix.startsWith("/admin/") ||
      prefix === "/admin" ||
      prefix.startsWith("/api/admin/") ||
      prefix === "/api/admin";

    const violations = FEATURE_ROUTE_RULES.flatMap((rule) =>
      (rule.prefixes ?? []).filter(isAdminPrefix).flatMap((prefix) => {
        const matched = adminPathnames.some(
          (pathname) =>
            pathname === prefix || pathname.startsWith(`${prefix}/`),
        );
        return matched
          ? []
          : [
              `feature "${rule.flag}" prefix "${prefix}" matches no admin page/route — a rename likely dropped its gate.`,
            ];
      }),
    );

    expect(violations).toEqual([]);
  });
});
