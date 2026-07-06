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

/**
 * Per-area permission level fields as stored on AccessRoleDefinition rows.
 * Declared here (not in admin-permissions.ts) so assignment-row inputs can
 * carry a joined definition without an import cycle.
 */
export type AccessRoleDefinitionLevelFields = {
  overviewLevel: "NONE" | "VIEW" | "EDIT";
  bookingsLevel: "NONE" | "VIEW" | "EDIT";
  membershipLevel: "NONE" | "VIEW" | "EDIT";
  financeLevel: "NONE" | "VIEW" | "EDIT";
  lodgeLevel: "NONE" | "VIEW" | "EDIT";
  contentLevel: "NONE" | "VIEW" | "EDIT";
  supportLevel: "NONE" | "VIEW" | "EDIT";
};

/**
 * A MemberAccessRole row shape: `role` is the enum value (null for rows
 * backed only by a custom definition); `roleDefinition` is the joined
 * AccessRoleDefinition when the caller selected it.
 */
export type AccessRoleAssignmentInput = {
  role: AppAccessRole | AccessRole | string | null;
  roleDefinitionId?: string | null;
  roleDefinition?:
    | (Partial<AccessRoleDefinitionLevelFields> & { id?: string })
    | null;
};

export type AccessRoleInput = {
  accessRoles?:
    | ReadonlyArray<AppAccessRole | AccessRole | string | AccessRoleAssignmentInput>
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

/**
 * Token-aware variant of normalizeAssignableAccessRoles: keeps definition-id
 * tokens as-is and applies the same canLogin clearing and legacy
 * Treasurer-supersedes-Finance-Viewer rule to the enum tokens. Callers must
 * validate definition-id tokens against the definitions table before
 * persisting.
 */
export function normalizeAssignableAccessRoleTokens(
  tokens: ReadonlyArray<string | null | undefined>,
  options: { canLogin?: boolean | null } = {},
): string[] {
  if (options.canLogin === false) return [];

  const deduped: string[] = [];
  for (const token of tokens) {
    if (!token || deduped.includes(token)) continue;
    deduped.push(token);
  }

  if (!deduped.includes("FINANCE_ADMIN")) return deduped;
  return deduped.filter((token) => token !== "FINANCE_USER");
}

export function resolveAccessRoles(input: AccessRoleInput): AppAccessRole[] {
  const explicit = (input.accessRoles ?? [])
    .map((item) => (typeof item === "string" ? item : item.role))
    .filter(isAccessRole);

  return normalizeAssignableAccessRoles(explicit, {
    canLogin: input.canLogin,
  });
}

/**
 * Canonical role token for an assignment: the enum value for system roles
 * and the seeded default bundles (which keep their enum value alongside the
 * definition link), and the AccessRoleDefinition id for custom roles.
 * Tokens are what the picker submits and what the Full-Admin gate compares.
 */
export function accessRoleTokenFromAssignment(
  item:
    | AppAccessRole
    | AccessRole
    | string
    | AccessRoleAssignmentInput
    | null
    | undefined,
): string | null {
  if (item == null) return null;
  if (typeof item === "string") return item || null;
  if (item.role) return item.role;
  return item.roleDefinitionId ?? item.roleDefinition?.id ?? null;
}

/**
 * Effective role tokens for a member, ignoring nothing but canLogin=false
 * (which clears all access). Unlike resolveAccessRoles this keeps
 * definition-backed custom roles (as definition-id tokens), so privileged
 * checks see them.
 */
export function resolveAccessRoleTokens(input: AccessRoleInput): string[] {
  if (input.canLogin === false) return [];
  const tokens: string[] = [];
  for (const item of input.accessRoles ?? []) {
    const token = accessRoleTokenFromAssignment(item);
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
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
// role token is privileged — including definition-id tokens, so custom roles
// always fall under the Full-Admin gate. Scoped admins (e.g. a Membership
// Officer with membership:edit) may still manage USER/ORG classification and
// login flags, but must not be able to grant or revoke privileged roles.
function isPrivilegedAccessRole(role: string) {
  return role !== "USER" && role !== "ORG";
}

/**
 * True when the member currently holds any privileged access role (issue
 * #1026): identity/credential-relevant edits (the login email) of such an
 * account are Full-Admin-only, because an email change plus a
 * forgot-password request hands the account and its roles to the new
 * address. Evaluated over role tokens so definition-backed custom roles
 * (which are always privileged) count.
 */
export function hasPrivilegedAccess(input: AccessRoleInput) {
  return resolveAccessRoleTokens(input).some(isPrivilegedAccessRole);
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
 * Every access role token a member's stored role fields can confer, ignoring
 * `canLogin`. Used by the Full Admin gate so a scoped admin can neither
 * change live access nor park a dormant elevated `role`/`financeAccessLevel`
 * on a non-login member for later activation. Definition-backed rows are
 * included as definition-id tokens.
 */
export function storedAccessRolesForFullAdminGate(member: {
  accessRoles?: ReadonlyArray<AccessRoleAssignmentInput | string> | null;
  role?: Role | string | null;
  financeAccessLevel?: FinanceAccessLevel | string | null;
}): string[] {
  const tokens: string[] = [];
  for (const candidate of [
    ...(member.accessRoles ?? []).map(accessRoleTokenFromAssignment),
    ...legacyRoleToAccessRoles(member.role, true),
    ...financeAccessLevelToAccessRoles(member.financeAccessLevel),
  ]) {
    if (candidate && !tokens.includes(candidate)) tokens.push(candidate);
  }
  return tokens;
}

export function hasLodgeAccess(input: AccessRoleInput) {
  const roles = resolveAccessRoles(input);
  return roles.includes("LODGE") || roles.includes("ADMIN");
}

/**
 * Derived presentation-only classification over access-role tokens (issue
 * #1439). There is no stored "user type" field: the admin UI derives this
 * from the same tokens it submits, so it can never disagree with the
 * capability system. Precedence: any privileged token other than LODGE
 * (admin bundles, finance roles, definition-id custom roles) classifies as
 * "admin"; LODGE without such a token is the kiosk account type; ORG is an
 * organisation; anything else — including a non-login record with no tokens
 * — is a plain user.
 */
export type UserType = "user" | "organisation" | "admin" | "lodge";

export const USER_TYPE_LABELS: Record<UserType, string> = {
  user: "User",
  organisation: "Organisation",
  admin: "Admin",
  lodge: "Lodge (kiosk account)",
};

export function deriveUserType(
  tokens: ReadonlyArray<string>,
  canLogin?: boolean | null,
): UserType {
  const effective = canLogin === false ? [] : tokens;
  if (
    effective.some(
      (token) => token !== "LODGE" && isPrivilegedAccessRole(token),
    )
  ) {
    return "admin";
  }
  if (effective.includes("LODGE")) return "lodge";
  if (effective.includes("ORG")) return "organisation";
  return "user";
}

/**
 * Token set produced by picking a User Type in the Edit Member UI (#1439).
 * "user" and "organisation" are single-token classifications; "admin" keeps
 * the current privileged tokens (dropping ORG — organisations cannot hold
 * admin roles) and holds USER per the "also a club member" toggle. "lodge"
 * is never selectable, so it is excluded from the input type. Callers still
 * run the result through normalizeAssignableAccessRoleTokens.
 */
export function accessRoleTokensForUserType(
  type: Exclude<UserType, "lodge">,
  currentTokens: ReadonlyArray<string>,
  options: { alsoClubMember?: boolean } = {},
): string[] {
  switch (type) {
    case "user":
      return ["USER"];
    case "organisation":
      return ["ORG"];
    case "admin": {
      const privileged = currentTokens.filter(isPrivilegedAccessRole);
      return options.alsoClubMember === false
        ? privileged
        : ["USER", ...privileged];
    }
  }
}

// Finance viewer/manager access is derived from the merged finance area
// level of the admin permission matrix; see hasFinanceViewerAccess and
// hasFinanceManagerAccess in @/lib/admin-permissions.
