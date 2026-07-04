import type { FinanceAccessLevel } from "@prisma/client";
import {
  isAccessRole,
  type AccessRoleDefinitionLevelFields,
  type AccessRoleInput,
  type AppAccessRole,
} from "@/lib/access-roles";

export const ADMIN_PERMISSION_LEVELS = ["none", "view", "edit"] as const;
export type AdminPermissionLevel = (typeof ADMIN_PERMISSION_LEVELS)[number];

export const ADMIN_PERMISSION_AREAS = [
  {
    key: "overview",
    label: "Admin Overview",
    description: "Dashboard and cross-area entry points.",
  },
  {
    key: "bookings",
    label: "Bookings & Beds",
    description: "Bookings, public booking requests, booking policy, waitlist, and bed allocation.",
  },
  {
    key: "membership",
    label: "Membership",
    description: "Members, applications, family links, memberships, inductions, and communications.",
  },
  {
    key: "finance",
    label: "Finance",
    description: "Payments, subscriptions, refunds, reports, Xero sync, and accounting setup.",
  },
  {
    key: "lodge",
    label: "Lodge Operations",
    description: "Hut leaders, rosters, chores, work parties, lodge settings, rooms, and beds.",
  },
  {
    key: "content",
    label: "Content",
    description: "Page content, site chrome, banners, public images, and site style.",
  },
  {
    key: "support",
    label: "Support & System",
    description: "Setup, modules, health, deliverability, audit, issue reports, and operational diagnostics.",
  },
] as const;

export type AdminPermissionArea = (typeof ADMIN_PERMISSION_AREAS)[number]["key"];
export type AdminPermissionMatrix = Record<
  AdminPermissionArea,
  AdminPermissionLevel
>;

export type AdminAccessRequirement = {
  area: AdminPermissionArea;
  level: Exclude<AdminPermissionLevel, "none">;
};

const LEVEL_RANK: Record<AdminPermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
};

const EMPTY_MATRIX = Object.fromEntries(
  ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
) as AdminPermissionMatrix;

/**
 * Legacy hardcoded bundles. `ADMIN` is the protected Full Admin matrix and is
 * always resolved from here, never from the database. Every other entry is
 * only a mid-deploy/pre-seed fallback for assignment rows whose
 * AccessRoleDefinition was not joined or has not been linked yet — the
 * database definitions (seeded identical to these, then club editable) are
 * authoritative. The fallback's failure mode is "yesterday's behavior",
 * never wider access.
 */
const ADMIN_ROLE_BUNDLES: Partial<
  Record<AppAccessRole, Partial<AdminPermissionMatrix>>
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
  FINANCE_USER: {
    finance: "view",
  },
};

const ROUTE_AREA_PREFIXES: Array<{
  area: AdminPermissionArea;
  prefixes: readonly string[];
}> = [
  {
    area: "finance",
    prefixes: [
      "/admin/xero",
      "/admin/payments",
      "/admin/internet-banking",
      "/admin/refund-requests",
      "/admin/reports",
      "/admin/subscriptions",
      "/api/admin/xero",
      "/api/admin/payments",
      "/api/admin/internet-banking-settings",
      "/api/admin/refund-requests",
      "/api/admin/reports",
      "/api/admin/subscriptions",
      "/api/admin/credit-approvals",
      "/api/admin/setup/finance-report-mappings",
      "/api/finance",
    ],
  },
  {
    area: "bookings",
    prefixes: [
      "/admin/bookings",
      "/admin/booking-requests",
      "/admin/book",
      "/admin/bed-allocation",
      "/admin/waitlist",
      "/admin/booking-approvals",
      "/admin/booking-change-requests",
      "/admin/booking-policies",
      "/admin/seasons",
      "/admin/age-tier-settings",
      "/admin/promo-codes",
      "/api/admin/bookings",
      "/api/admin/booking-requests",
      "/api/admin/booking-reviews",
      "/api/admin/booking-change-requests",
      "/api/admin/bed-allocation",
      "/api/admin/waitlist",
      "/api/admin/booking-policies",
      "/api/admin/seasons",
      "/api/admin/age-tier-settings",
      "/api/admin/promo-codes",
    ],
  },
  {
    area: "membership",
    prefixes: [
      "/admin/members",
      "/admin/member-applications",
      "/admin/membership-cancellation",
      "/admin/membership-cancellations",
      "/admin/membership-types",
      "/admin/member-fields",
      "/admin/induction",
      "/admin/communications",
      "/admin/lockers",
      "/admin/family-groups",
      "/admin/family-suggestions",
      "/admin/deletion-requests",
      "/admin/committee",
      "/api/admin/members",
      "/api/admin/member-applications",
      "/api/admin/induction-templates",
      "/api/admin/membership-cancellation",
      "/api/admin/membership-cancellations",
      "/api/admin/membership-cancellation-requests",
      "/api/admin/membership-cancellation-settings",
      "/api/admin/membership-lockout-settings",
      "/api/admin/membership-types",
      "/api/admin/member-fields",
      "/api/admin/induction",
      "/api/admin/inductions",
      "/api/admin/communications",
      "/api/admin/lockers",
      "/api/admin/family-groups",
      "/api/admin/family-suggestions",
      "/api/admin/deletion-requests",
      "/api/admin/committee",
      "/api/admin/membership-nomination-settings",
      "/api/admin/member-lifecycle-action-requests",
    ],
  },
  {
    area: "lodge",
    prefixes: [
      "/admin/hut-leaders",
      "/admin/roster",
      "/admin/chores",
      "/admin/lodge",
      "/admin/work-parties",
      "/admin/lodge-instructions",
      "/admin/rooms-beds",
      "/api/admin/hut-leaders",
      "/api/admin/roster",
      "/api/admin/chores",
      "/api/admin/lodge",
      "/api/admin/work-parties",
      "/api/admin/lodge-instructions",
      "/api/admin/lodge-settings",
    ],
  },
  {
    area: "content",
    prefixes: [
      "/admin/page-content",
      "/admin/site-banners",
      "/admin/site-content",
      "/admin/image-manager",
      "/admin/site-style",
      "/admin/mountain-conditions",
      "/api/admin/page-content",
      "/api/admin/site-banners",
      "/api/admin/site-content",
      "/api/admin/image-manager",
      "/api/admin/image-library",
      "/api/admin/site-images",
      "/api/admin/site-style",
      "/api/admin/mountain-conditions",
    ],
  },
  {
    area: "support",
    prefixes: [
      "/admin/access-roles",
      "/admin/setup",
      "/admin/modules",
      "/admin/subscription-lockout",
      "/admin/notifications",
      "/admin/notification-rules",
      "/admin/notification-recipients",
      "/admin/booking-messages",
      "/admin/email-messages",
      "/admin/email-deliverability",
      "/admin/health",
      "/admin/background-jobs",
      "/admin/stuck-states",
      "/admin/issue-reports",
      "/admin/audit-log",
      "/api/admin/access-roles",
      "/api/admin/setup",
      "/api/admin/modules",
      "/api/admin/notifications",
      "/api/admin/notification-delivery-policies",
      "/api/admin/booking-messages",
      "/api/admin/email",
      "/api/admin/email-failures",
      "/api/admin/email-templates",
      "/api/admin/email-settings",
      "/api/admin/email-suppressions",
      "/api/admin/health",
      "/api/admin/runtime-status",
      "/api/admin/stuck-states",
      "/api/admin/issue-reports",
      "/api/admin/audit-log",
    ],
  },
  {
    area: "overview",
    prefixes: ["/admin", "/api/admin"],
  },
];

const EDIT_ON_GET_PREFIXES = [
  "/api/admin/xero/callback",
  "/api/admin/xero/connect",
] as const;

const SPECIAL_ROUTE_AREA_PATTERNS: Array<{
  area: AdminPermissionArea;
  pattern: RegExp;
}> = [
  {
    area: "finance",
    pattern: /^\/api\/admin\/members\/[^/]+\/credits(?:\/[^/]+)?$/,
  },
  {
    area: "finance",
    pattern: /^\/api\/admin\/members\/[^/]+\/xero-(?:link|push|unlink)$/,
  },
];

function cloneEmptyMatrix(): AdminPermissionMatrix {
  return { ...EMPTY_MATRIX };
}

function maxLevel(
  current: AdminPermissionLevel,
  candidate: AdminPermissionLevel,
) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function definitionLevelToAppLevel(
  level: AccessRoleDefinitionLevelFields[keyof AccessRoleDefinitionLevelFields] | undefined,
): AdminPermissionLevel | null {
  switch (level) {
    case "NONE":
      return "none";
    case "VIEW":
      return "view";
    case "EDIT":
      return "edit";
    default:
      return null;
  }
}

/** Permission matrix stored on an AccessRoleDefinition row. */
export function matrixFromAccessRoleDefinition(
  definition: Partial<AccessRoleDefinitionLevelFields>,
): AdminPermissionMatrix {
  const matrix = cloneEmptyMatrix();
  for (const area of ADMIN_PERMISSION_AREAS) {
    const level = definitionLevelToAppLevel(definition[`${area.key}Level`]);
    if (level) matrix[area.key] = level;
  }
  return matrix;
}

/** Merge = max level per area; used for both members and picker previews. */
export function mergeAdminPermissionMatrices(
  matrices: ReadonlyArray<Partial<AdminPermissionMatrix>>,
): AdminPermissionMatrix {
  const matrix = cloneEmptyMatrix();
  for (const candidate of matrices) {
    for (const area of ADMIN_PERMISSION_AREAS) {
      const level = candidate[area.key];
      if (!level) continue;
      matrix[area.key] = maxLevel(matrix[area.key], level);
    }
  }
  return matrix;
}

/**
 * Merged permission matrix for a member's access-role assignments.
 *
 * Per-row resolution, strictly in this order:
 * 1. `ADMIN` → the hardcoded Full Admin bundle, never the database.
 * 2. A joined `roleDefinition` (definition-backed or seeded-default row
 *    selected with the definition include) → that definition's matrix.
 * 3. A bare enum value → the legacy hardcoded bundle (mid-deploy/pre-seed
 *    fallback; identical to the seeded definitions until the club edits
 *    them).
 * 4. Anything unresolved (e.g. a custom-role row selected without its
 *    definition) contributes nothing — fail closed, never wider.
 */
export function getAdminPermissionMatrix(
  input: AccessRoleInput,
): AdminPermissionMatrix {
  if (input.canLogin === false) return cloneEmptyMatrix();

  const matrices: Array<Partial<AdminPermissionMatrix>> = [];
  for (const item of input.accessRoles ?? []) {
    const role = typeof item === "string" ? item : item.role;
    if (role === "ADMIN") {
      matrices.push(ADMIN_ROLE_BUNDLES.ADMIN ?? {});
      continue;
    }

    const definition = typeof item === "string" ? null : item.roleDefinition;
    if (definition) {
      matrices.push(matrixFromAccessRoleDefinition(definition));
      continue;
    }

    if (isAccessRole(role)) {
      const bundle = ADMIN_ROLE_BUNDLES[role];
      if (bundle) matrices.push(bundle);
    }
  }

  return mergeAdminPermissionMatrices(matrices);
}

// test seam
export function getAdminPermissionLevel(
  input: AccessRoleInput,
  area: AdminPermissionArea,
): AdminPermissionLevel {
  return getAdminPermissionMatrix(input)[area];
}

export function hasAdminPortalAccess(input: AccessRoleInput) {
  const matrix = getAdminPermissionMatrix(input);
  return ADMIN_PERMISSION_AREAS.some(
    (area) => matrix[area.key] !== "none" && area.key !== "finance",
  );
}

export function hasAdminAreaAccess(
  input: AccessRoleInput,
  requirement: AdminAccessRequirement,
) {
  return (
    LEVEL_RANK[getAdminPermissionLevel(input, requirement.area)] >=
    LEVEL_RANK[requirement.level]
  );
}

export function getFirstAccessibleAdminHref(input: AccessRoleInput) {
  const matrix = getAdminPermissionMatrix(input);
  if (matrix.overview !== "none") return "/admin/dashboard";
  if (matrix.bookings !== "none") return "/admin/bookings";
  if (matrix.membership !== "none") return "/admin/members";
  if (matrix.finance !== "none") return "/admin/payments";
  if (matrix.lodge !== "none") return "/admin/hut-leaders";
  if (matrix.content !== "none") return "/admin/page-content";
  if (matrix.support !== "none") return "/admin/health";
  return null;
}

function normalizePathname(pathname: string) {
  const candidate = pathname.split(/[?#]/)[0] || "/";
  return candidate.endsWith("/") && candidate !== "/"
    ? candidate.replace(/\/+$/, "")
    : candidate;
}

function methodRequiresEdit(method?: string | null) {
  if (!method) return false;
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function getAdminRouteRequirement(
  pathname: string,
  method?: string | null,
): AdminAccessRequirement | null {
  const normalized = normalizePathname(pathname);
  const specialRoute = SPECIAL_ROUTE_AREA_PATTERNS.find(({ pattern }) =>
    pattern.test(normalized),
  );
  const route =
    specialRoute ??
    ROUTE_AREA_PREFIXES.find(({ prefixes }) =>
      prefixes.some(
        (prefix) =>
          normalized === prefix || normalized.startsWith(`${prefix}/`),
      ),
    );

  if (!route) return null;

  const forcedEdit = EDIT_ON_GET_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );

  return {
    area: route.area,
    level: forcedEdit || methodRequiresEdit(method) ? "edit" : "view",
  };
}

export function canViewAdminHref(input: AccessRoleInput, href: string) {
  const requirement = getAdminRouteRequirement(href, "GET");
  return requirement ? hasAdminAreaAccess(input, requirement) : false;
}

/**
 * Matrix-based variant for client components (e.g. the admin sidebar), which
 * receive the precomputed matrix from a server layout instead of raw roles —
 * definitions live in the database and cannot be resolved client-side.
 */
export function canViewAdminHrefWithMatrix(
  matrix: AdminPermissionMatrix,
  href: string,
) {
  const requirement = getAdminRouteRequirement(href, "GET");
  if (!requirement) return false;
  return LEVEL_RANK[matrix[requirement.area]] >= LEVEL_RANK[requirement.level];
}

/**
 * Finance portal access derives from the merged finance area level of the
 * admin permission matrix: view ⇒ finance viewer, edit ⇒ finance manager.
 * Seeded "Treasurer" is finance edit and "Finance Viewer" is finance view,
 * both club-editable like any other definition-backed role.
 */
export function hasFinanceViewerAccess(input: AccessRoleInput) {
  return LEVEL_RANK[getAdminPermissionMatrix(input).finance] >= LEVEL_RANK.view;
}

export function hasFinanceManagerAccess(input: AccessRoleInput) {
  return getAdminPermissionMatrix(input).finance === "edit";
}

/**
 * Legacy `Member.financeAccessLevel` compatibility value derived from the
 * merged matrix; synchronized on role writes for display/back-compat only —
 * runtime guards never read it.
 */
export function financeAccessLevelFromMatrix(
  matrix: AdminPermissionMatrix,
): FinanceAccessLevel {
  if (matrix.finance === "edit") return "MANAGER";
  if (matrix.finance === "view") return "VIEWER";
  return "NONE";
}
