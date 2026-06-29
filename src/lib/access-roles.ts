import type { AccessRole, FinanceAccessLevel, Role } from "@prisma/client";

export const ACCESS_ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
  "FINANCE_USER",
  "FINANCE_ADMIN",
  "ORG",
] as const satisfies readonly AccessRole[];

export type AppAccessRole = (typeof ACCESS_ROLE_VALUES)[number];

export const ACCESS_ROLE_LABELS: Record<AppAccessRole, string> = {
  USER: "User",
  ADMIN: "Admin",
  LODGE: "Lodge",
  FINANCE_USER: "Finance User",
  FINANCE_ADMIN: "Finance Admin",
  ORG: "Organisation",
};

export const ACCESS_ROLE_DESCRIPTIONS: Record<AppAccessRole, string> = {
  USER: "Can use normal member-facing account features.",
  ADMIN: "Can access admin tools and manage club operations.",
  LODGE: "Can use lodge kiosk and lodge operations tools.",
  FINANCE_USER: "Can view finance dashboard data.",
  FINANCE_ADMIN: "Can manage finance dashboard syncs and mappings.",
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
  if (explicit.length > 0) {
    return normalizeAssignableAccessRoles(explicit, {
      canLogin: input.canLogin,
    });
  }

  return normalizeAssignableAccessRoles([
    ...legacyRoleToAccessRoles(input.role, input.canLogin),
    ...financeAccessLevelToAccessRoles(input.financeAccessLevel),
  ], { canLogin: input.canLogin });
}

export function hasAccessRole(input: AccessRoleInput, role: AppAccessRole) {
  return resolveAccessRoles(input).includes(role);
}

export function hasUserAccess(input: AccessRoleInput) {
  const roles = resolveAccessRoles(input);
  return roles.includes("USER") || roles.includes("ADMIN");
}

export function hasAdminAccess(input: AccessRoleInput) {
  return hasAccessRole(input, "ADMIN");
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
