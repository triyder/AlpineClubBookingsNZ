import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canViewAdminHref,
  canViewAdminHrefWithMatrix,
  financeAccessLevelFromMatrix,
  getAdminPermissionLevel,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
  type AdminPermissionArea,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import { type AppAccessRole } from "@/lib/access-roles";

const LODGE_ONLY_DEFINITION = {
  overviewLevel: "NONE",
  bookingsLevel: "NONE",
  membershipLevel: "NONE",
  financeLevel: "NONE",
  lodgeLevel: "EDIT",
  contentLevel: "NONE",
  supportLevel: "NONE",
} as const;

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

describe("definition-backed access roles", () => {
  it("prefers a joined definition over the legacy bundle for the same enum role", () => {
    // Club edited Booking Officer down to bookings: view.
    const matrix = getAdminPermissionMatrix({
      accessRoles: [
        {
          role: "ADMIN_BOOKINGS",
          roleDefinitionId: "ardef_admin_bookings",
          roleDefinition: {
            overviewLevel: "VIEW",
            bookingsLevel: "VIEW",
            membershipLevel: "NONE",
            financeLevel: "NONE",
            lodgeLevel: "NONE",
            contentLevel: "NONE",
            supportLevel: "NONE",
          },
        },
      ],
      canLogin: true,
    });
    expect(matrix.bookings).toBe("view");
    expect(matrix.lodge).toBe("none");
  });

  it("resolves custom definition-backed rows with no enum value", () => {
    const subject = {
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_custom",
          roleDefinition: LODGE_ONLY_DEFINITION,
        },
      ],
      canLogin: true,
    };
    expect(getAdminPermissionLevel(subject, "lodge")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "bookings")).toBe("none");
  });

  it("fails closed for custom rows selected without their definition", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [{ role: null, roleDefinitionId: "ardef_custom" }],
      canLogin: true,
    });
    expect(Object.values(matrix).every((level) => level === "none")).toBe(
      true,
    );
  });

  it("always resolves ADMIN from the hardcoded bundle, never a definition", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [
        {
          role: "ADMIN",
          roleDefinitionId: "ardef_rogue",
          roleDefinition: LODGE_ONLY_DEFINITION,
        },
      ],
      canLogin: true,
    });
    expect(Object.values(matrix).every((level) => level === "edit")).toBe(
      true,
    );
  });

  it("keeps the legacy bundle as fallback for bare enum rows", () => {
    expect(
      getAdminPermissionLevel({ accessRoles: ["ADMIN_BOOKINGS"] }, "bookings"),
    ).toBe("edit");
    expect(
      getAdminPermissionLevel({ accessRoles: ["FINANCE_USER"] }, "finance"),
    ).toBe("view");
  });

  it("supports matrix-based nav checks for client components", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: ["ADMIN_CONTENT"],
      canLogin: true,
    });
    expect(canViewAdminHrefWithMatrix(matrix, "/admin/page-content")).toBe(
      true,
    );
    expect(canViewAdminHrefWithMatrix(matrix, "/admin/payments")).toBe(false);
  });
});

describe("matrix-derived finance access", () => {
  it("treats finance edit as manager and finance view as viewer", () => {
    expect(hasFinanceManagerAccess({ accessRoles: ["FINANCE_ADMIN"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["FINANCE_USER"] })).toBe(
      true,
    );
    expect(hasFinanceManagerAccess({ accessRoles: ["FINANCE_USER"] })).toBe(
      false,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["USER"] })).toBe(false);
  });

  it("gives Full Admin manager access and scoped admins viewer access via their matrices", () => {
    // Intentional widening vs the legacy enum-keyed helpers.
    expect(hasFinanceManagerAccess({ accessRoles: ["ADMIN"] })).toBe(true);
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_READONLY"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_BOOKINGS"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_CONTENT"] })).toBe(
      false,
    );
  });

  it("derives finance access from custom definitions", () => {
    const financeViewRole = {
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_custom_finance",
          roleDefinition: {
            ...LODGE_ONLY_DEFINITION,
            lodgeLevel: "NONE",
            financeLevel: "VIEW",
          },
        },
      ],
      canLogin: true,
    } as const;
    expect(hasFinanceViewerAccess(financeViewRole)).toBe(true);
    expect(hasFinanceManagerAccess(financeViewRole)).toBe(false);
  });

  it("maps matrices to the legacy financeAccessLevel compatibility values", () => {
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["FINANCE_ADMIN"] }),
      ),
    ).toBe("MANAGER");
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["ADMIN_MEMBERSHIP"] }),
      ),
    ).toBe("VIEWER");
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["USER"] }),
      ),
    ).toBe("NONE");
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
  // Finance access is matrix-derived: the seeded Finance Viewer definition
  // (and its fallback bundle) grants read-only finance admin access.
  FINANCE_USER: {
    finance: "view",
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
// empty-role identities. LODGE uses the lodge kiosk surface; ORG has no
// admin surface at all. FINANCE_USER is checked via the bundle truth table
// instead: its matrix-derived finance view allows read-only finance-area
// access.
const ALWAYS_DENIED_IDENTITIES: Array<{
  label: string;
  accessRoles: AppAccessRole[];
}> = [
  { label: "anonymous / no roles", accessRoles: [] },
  { label: "plain member", accessRoles: ["USER"] },
  { label: "lodge kiosk", accessRoles: ["LODGE"] },
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

  it("denies anonymous, plain member, lodge, and org identities on every admin route", () => {
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
