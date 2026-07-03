import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canViewAdminHref,
  getAdminPermissionLevel,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminPermissionArea,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import { type AppAccessRole } from "@/lib/access-roles";

describe("admin permission bundles", () => {
  it("gives full admins edit access everywhere", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [{ role: "ADMIN" }],
      canLogin: true,
    });

    expect(Object.values(matrix).every((level) => level === "edit")).toBe(true);
    expect(hasAdminPortalAccess({ accessRoles: ["ADMIN"] })).toBe(true);
  });

  it("keeps read-only admin users at view access", () => {
    expect(
      getAdminPermissionLevel({ accessRoles: ["ADMIN_READONLY"] }, "bookings"),
    ).toBe("view");
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_READONLY"] },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(false);
  });

  it("merges bundled roles into a custom composed permission set", () => {
    const subject = {
      accessRoles: ["ADMIN_MEMBERSHIP", "ADMIN_CONTENT"],
      canLogin: true,
    };

    expect(getAdminPermissionLevel(subject, "membership")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "content")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "bookings")).toBe("view");
    expect(getAdminPermissionLevel(subject, "finance")).toBe("view");
  });

  it("keeps finance viewers out of the admin portal while allowing treasurers", () => {
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_USER"] })).toBe(false);
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_ADMIN"] })).toBe(true);
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["FINANCE_ADMIN"] },
        { area: "finance", level: "edit" },
      ),
    ).toBe(true);
  });
});

describe("admin route requirements", () => {
  it("maps admin pages to view-level area access", () => {
    expect(getAdminRouteRequirement("/admin/members/123", "GET")).toEqual({
      area: "membership",
      level: "view",
    });
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/page-content"),
    ).toBe(true);
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/members"),
    ).toBe(false);
  });

  it("maps mutating admin API methods to edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/page-content", "POST")).toEqual({
      area: "content",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/members/member-1/xero-link", "POST"),
    ).toEqual({
      area: "finance",
      level: "edit",
    });
  });

  it("keeps real admin APIs in their intended areas instead of overview fallback", () => {
    expect(
      getAdminRouteRequirement(
        "/api/admin/membership-cancellation-requests",
        "GET",
      ),
    ).toEqual({
      area: "membership",
      level: "view",
    });
    expect(
      getAdminRouteRequirement("/api/admin/induction-templates", "POST"),
    ).toEqual({
      area: "membership",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/email-failures/failure-1/review", "POST"),
    ).toEqual({
      area: "support",
      level: "edit",
    });
  });

  it("treats state-changing provider GET endpoints as edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/xero/callback", "GET")).toEqual({
      area: "finance",
      level: "edit",
    });
  });
});

// ---------------------------------------------------------------------------
// Authorization matrix over every real admin API route (issue #1132).
//
// Enumerates src/app/api/admin/**/route.ts from the filesystem and, for every
// exported HTTP method, resolves the effective admin requirement with the real
// getAdminRouteRequirement machinery (no route passes an explicit `permission`
// option today, so the inferred requirement IS the production requirement).
// Each identity class is then checked against hasAdminAreaAccess:
//   - anonymous / no-roles and plain members must always be denied;
//   - every role bundle must match the hand-written truth table below.
// The truth table intentionally duplicates ADMIN_ROLE_BUNDLES: a change to a
// bundle (or to the route→area prefix map) must show up here as a reviewable
// test diff instead of silently widening access.
// ---------------------------------------------------------------------------

const ADMIN_API_DIR = path.join(process.cwd(), "src/app/api/admin");

function listAdminRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listAdminRouteFiles(entryPath);
    return entry.name === "route.ts" ? [entryPath] : [];
  });
}

/** src/app/api/admin/foo/[id]/route.ts -> /api/admin/foo/dynamic-id */
function routeFileToPathname(filePath: string) {
  const relative = path
    .relative(path.join(process.cwd(), "src/app"), path.dirname(filePath))
    .split(path.sep)
    .join("/");
  return `/${relative}`.replace(/\[[^\]]+\]/g, "dynamic-id");
}

function exportedHttpMethods(filePath: string): string[] {
  const contents = fs.readFileSync(filePath, "utf8");
  return [
    ...contents.matchAll(
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g,
    ),
  ].map((match) => match[1]);
}

// Hand-written truth table: what each role bundle may do per admin area.
// Mirrors ADMIN_ROLE_BUNDLES in src/lib/admin-permissions.ts on purpose.
const EXPECTED_BUNDLE_LEVELS: Record<
  string,
  Partial<Record<AdminPermissionArea, AdminPermissionLevel>>
> = {
  ADMIN: {
    overview: "edit",
    bookings: "edit",
    membership: "edit",
    finance: "edit",
    lodge: "edit",
    content: "edit",
    support: "edit",
  },
  ADMIN_READONLY: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: "view",
    content: "view",
    support: "view",
  },
  ADMIN_BOOKINGS: {
    overview: "view",
    bookings: "edit",
    membership: "view",
    finance: "view",
    lodge: "edit",
    support: "view",
  },
  ADMIN_MEMBERSHIP: {
    overview: "view",
    bookings: "view",
    membership: "edit",
    finance: "view",
    support: "view",
  },
  ADMIN_CONTENT: {
    overview: "view",
    content: "edit",
  },
  FINANCE_ADMIN: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "edit",
    support: "view",
  },
};

// Roles that must never pass an admin API requirement, plus the anonymous /
// empty-role identities. FINANCE_USER uses the separate /api/finance surface;
// LODGE uses the lodge kiosk surface; ORG has no admin surface at all.
const ALWAYS_DENIED_IDENTITIES: Array<{
  label: string;
  accessRoles: AppAccessRole[];
}> = [
  { label: "anonymous / no roles", accessRoles: [] },
  { label: "plain member", accessRoles: ["USER"] },
  { label: "lodge kiosk", accessRoles: ["LODGE"] },
  { label: "finance viewer", accessRoles: ["FINANCE_USER"] },
  { label: "organisation", accessRoles: ["ORG"] },
];

const LEVEL_RANK: Record<AdminPermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
};

// Admin API routes allowed to resolve to the `/api/admin` overview catch-all.
// Overview view access is granted to EVERY scoped admin bundle, so an
// unmapped route silently becomes readable by all of them. Keep this list
// empty-by-default: a new admin route must be added to a specific area prefix
// in ROUTE_AREA_PREFIXES (src/lib/admin-permissions.ts) or consciously listed
// here with a justification.
const OVERVIEW_CATCH_ALL_ALLOWLIST: string[] = [
  // Cross-area navigation badge counts for the admin shell; genuinely
  // belongs to "overview" (every scoped admin sees the nav).
  "/api/admin/pending-counts",
];

describe("admin API authorization matrix (issue #1132)", () => {
  const routeFiles = listAdminRouteFiles(ADMIN_API_DIR).sort();
  const routeMethodPairs = routeFiles.flatMap((filePath) => {
    const pathname = routeFileToPathname(filePath);
    return exportedHttpMethods(filePath).map((method) => ({
      pathname,
      method,
    }));
  });

  it("finds a plausible number of admin routes and methods", () => {
    // Guard the enumeration itself: if the walker breaks and returns nothing,
    // every other assertion would pass vacuously.
    expect(routeFiles.length).toBeGreaterThan(150);
    expect(routeMethodPairs.length).toBeGreaterThan(routeFiles.length);
  });

  it("resolves every admin API route and method to an admin requirement", () => {
    const unresolved = routeMethodPairs.filter(
      ({ pathname, method }) =>
        getAdminRouteRequirement(pathname, method) === null,
    );

    expect(unresolved).toEqual([]);
  });

  it("keeps the overview catch-all allowlist exact", () => {
    const overviewRoutes = [
      ...new Set(
        routeMethodPairs
          .filter(
            ({ pathname, method }) =>
              getAdminRouteRequirement(pathname, method)?.area === "overview",
          )
          .map(({ pathname }) => pathname),
      ),
    ].sort();

    expect(overviewRoutes).toEqual([...OVERVIEW_CATCH_ALL_ALLOWLIST].sort());
  });

  it("denies anonymous, plain member, lodge, finance-viewer, and org identities on every admin route", () => {
    const violations = routeMethodPairs.flatMap(({ pathname, method }) => {
      const requirement = getAdminRouteRequirement(pathname, method);
      if (!requirement) return [];

      return ALWAYS_DENIED_IDENTITIES.flatMap(({ label, accessRoles }) =>
        hasAdminAreaAccess({ accessRoles }, requirement)
          ? [`${pathname}#${method}: unexpectedly allows ${label}`]
          : [],
      );
    });

    expect(violations).toEqual([]);
  });

  it("matches the hand-written role-bundle truth table on every admin route", () => {
    const violations = routeMethodPairs.flatMap(({ pathname, method }) => {
      const requirement = getAdminRouteRequirement(pathname, method);
      if (!requirement) return [];

      return Object.entries(EXPECTED_BUNDLE_LEVELS).flatMap(
        ([role, areaLevels]) => {
          const grantedLevel = areaLevels[requirement.area] ?? "none";
          const expected =
            LEVEL_RANK[grantedLevel] >= LEVEL_RANK[requirement.level];
          const actual = hasAdminAreaAccess(
            { accessRoles: [role as AppAccessRole] },
            requirement,
          );

          return actual === expected
            ? []
            : [
                `${pathname}#${method}: ${role} expected ${
                  expected ? "allow" : "deny"
                } for ${requirement.area}:${requirement.level} but machinery ${
                  actual ? "allowed" : "denied"
                }`,
              ];
        },
      );
    });

    expect(violations).toEqual([]);
  });
});
