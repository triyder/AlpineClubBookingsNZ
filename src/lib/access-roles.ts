import type { AccessRole, FinanceAccessLevel, Role } from "@prisma/client";

export const ACCESS_ROLE_VALUES = [
  "USER",
  "ADMIN",
  "ADMIN_READONLY",
  "ADMIN_BOOKINGS",
  "ADMIN_MEMBERSHIP",
  "ADMIN_CONTENT",
  "LODGE",
  "FINANCE_USER",
  "FINANCE_ADMIN",
  "ORG",
] as const satisfies readonly AccessRole[];

export type AppAccessRole = (typeof ACCESS_ROLE_VALUES)[number];

export const ACCESS_ROLE_LABELS: Record<AppAccessRole, string> = {
  USER: "User",
  ADMIN: "Full Admin",
  ADMIN_READONLY: "Read-only Admin",
  ADMIN_BOOKINGS: "Booking Officer",
  ADMIN_MEMBERSHIP: "Membership Officer",
  ADMIN_CONTENT: "Content Manager",
  LODGE: "Lodge",
  FINANCE_USER: "Finance Viewer",
  FINANCE_ADMIN: "Treasurer",
  ORG: "Organisation",
};

export const ACCESS_ROLE_DESCRIPTIONS: Record<AppAccessRole, string> = {
  USER: "Can use normal member-facing account features.",
  ADMIN: "Can view and edit every admin area.",
  ADMIN_READONLY: "Can view admin areas without making changes.",
  ADMIN_BOOKINGS: "Can manage bookings, bed allocation, and lodge operations.",
  ADMIN_MEMBERSHIP: "Can manage members, applications, and membership setup.",
  ADMIN_CONTENT: "Can manage public website content, banners, and images.",
  LODGE: "Can use lodge kiosk and lodge operations tools.",
  FINANCE_USER: "Can view finance dashboard data.",
  FINANCE_ADMIN: "Can manage finance, payments, subscriptions, and Xero.",
  ORG: "Can use organisation self-service flows without member status.",
};

export type AccessRoleInput = {
  accessRoles?:
    | ReadonlyArray<AppAccessRole | AccessRole | string | { role: AppAccessRole | AccessRole | string }>
    | null;
  role?: Role | string | null;
  financeAccessLevel?: FinanceAccessLevel | string | null;
  canLogin?: boolean | null;
};

export function isAccessRole(
  value: string | null | undefined,
): value is AppAccessRole {
  return ACCESS_ROLE_VALUES.includes(value as AppAccessRole);
}

export function legacyRoleToAccessRoles(
  role: Role | string | null | undefined,
  canLogin?: boolean | null,
): AppAccessRole[] {
  switch (role) {
    case "USER":
      return ["USER"];
    case "ADMIN":
      return ["ADMIN"];
    case "LODGE":
      return ["LODGE"];
    case "SCHOOL":
      return canLogin ? ["ORG"] : [];
    default:
      return [];
  }
}

export function financeAccessLevelToAccessRoles(
  financeAccessLevel: FinanceAccessLevel | string | null | undefined,
): AppAccessRole[] {
  switch (financeAccessLevel) {
    case "VIEWER":
      return ["FINANCE_USER"];
    case "MANAGER":
      return ["FINANCE_ADMIN"];
    default:
      return [];
  }
}

export function financeAccessLevelFromAccessRoles(
  roles: ReadonlyArray<string>,
): FinanceAccessLevel {
  if (roles.includes("FINANCE_ADMIN")) return "MANAGER";
  if (roles.includes("FINANCE_USER")) return "VIEWER";
  return "NONE";
}

export function legacyRoleFromAccessRoles(
  roles: ReadonlyArray<string>,
): Role {
  if (roles.includes("ADMIN")) return "ADMIN";
  if (roles.includes("LODGE")) return "LODGE";
  if (roles.includes("ORG")) return "SCHOOL";
  return "USER";
}

export function authorizationRoleFromAccessRoles(input: AccessRoleInput): Role {
  return legacyRoleFromAccessRoles(resolveAccessRoles(input));
}

export function dedupeAccessRoles(
  roles: ReadonlyArray<string | null | undefined>,
): AppAccessRole[] {
  const result: AppAccessRole[] = [];
  for (const role of roles) {
    if (!isAccessRole(role) || result.includes(role)) continue;
    result.push(role);
  }
  return result;
}

export function normalizeAssignableAccessRoles(
  roles: ReadonlyArray<string | null | undefined>,
  options: { canLogin?: boolean | null } = {},
): AppAccessRole[] {
  if (options.canLogin === false) return [];

  const deduped = dedupeAccessRoles(roles);
  if (!deduped.includes("FINANCE_ADMIN")) {
    return deduped;
  }

  return deduped.filter((role) => role !== "FINANCE_USER");
}

export function resolveAccessRoles(input: AccessRoleInput): AppAccessRole[] {
  const explicit = (input.accessRoles ?? [])
    .map((item) => (typeof item === "string" ? item : item.role))
    .filter(isAccessRole);

  return normalizeAssignableAccessRoles(explicit, {
    canLogin: input.canLogin,
  });
}

export function accessRolesFromCompatibilityFields(
  input: Pick<AccessRoleInput, "role" | "financeAccessLevel" | "canLogin">,
): AppAccessRole[] {
  return normalizeAssignableAccessRoles([
    ...legacyRoleToAccessRoles(input.role, input.canLogin),
    ...financeAccessLevelToAccessRoles(input.financeAccessLevel),
  ], { canLogin: input.canLogin });
}

export function hasAccessRole(input: AccessRoleInput, role: AppAccessRole) {
  return resolveAccessRoles(input).includes(role);
}

export function hasAdminAccess(input: AccessRoleInput) {
  return hasAccessRole(input, "ADMIN");
}

/**
 * Separation-of-duties check for access-role writes (issue #1012): only a
 * Full Admin (the `ADMIN` access role) may grant or revoke privileged access.
 */
export function isFullAdmin(input: AccessRoleInput) {
  return hasAdminAccess(input);
}

// USER and ORG carry no admin, finance, or lodge access; every other access
// role is privileged. Scoped admins (e.g. a Membership Officer with
// membership:edit) may still manage USER/ORG classification and login flags,
// but must not be able to grant or revoke privileged roles.
function isPrivilegedAccessRole(role: string) {
  return role !== "USER" && role !== "ORG";
}

/**
 * True when the member currently holds any privileged access role (issue
 * #1026): identity/credential-relevant edits (the login email) of such an
 * account are Full-Admin-only, because an email change plus a
 * forgot-password request hands the account and its roles to the new
 * address.
 */
export function hasPrivilegedAccess(input: AccessRoleInput) {
  return resolveAccessRoles(input).some(isPrivilegedAccessRole);
}

/**
 * True when moving a member from `before` to `after` grants or revokes any
 * privileged access role, which only a Full Admin may do (issue #1012).
 * Submitting an unchanged role set never trips this.
 */
export function accessRoleChangeRequiresFullAdmin(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): boolean {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const role of new Set([...before, ...after])) {
    if (
      isPrivilegedAccessRole(role) &&
      beforeSet.has(role) !== afterSet.has(role)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every access role a member's stored role fields can confer, ignoring
 * `canLogin`. Used by the Full Admin gate so a scoped admin can neither
 * change live access nor park a dormant elevated `role`/`financeAccessLevel`
 * on a non-login member for later activation.
 */
export function storedAccessRolesForFullAdminGate(member: {
  accessRoles?: ReadonlyArray<{ role: AccessRole | string } | string> | null;
  role?: Role | string | null;
  financeAccessLevel?: FinanceAccessLevel | string | null;
}): AppAccessRole[] {
  return dedupeAccessRoles([
    ...(member.accessRoles ?? []).map((item) =>
      typeof item === "string" ? item : item.role,
    ),
    ...legacyRoleToAccessRoles(member.role, true),
    ...financeAccessLevelToAccessRoles(member.financeAccessLevel),
  ]);
}

export function hasLodgeAccess(input: AccessRoleInput) {
  const roles = resolveAccessRoles(input);
  return roles.includes("LODGE") || roles.includes("ADMIN");
}

export function hasFinanceViewerAccess(input: AccessRoleInput) {
  const roles = resolveAccessRoles(input);
  return roles.includes("FINANCE_USER") || roles.includes("FINANCE_ADMIN");
}

export function hasFinanceManagerAccess(input: AccessRoleInput) {
  return hasAccessRole(input, "FINANCE_ADMIN");
}
