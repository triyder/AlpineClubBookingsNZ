import type { FinanceAccessLevel, Prisma, Role } from "@prisma/client";
import {
  accessRolesFromCompatibilityFields,
  normalizeAssignableAccessRoleTokens,
  type AppAccessRole,
} from "@/lib/access-roles";
import {
  accessRoleAssignmentRowsFromTokens,
  loadAccessRoleDefinitions,
  type AccessRoleDefinitionRecord,
} from "@/lib/access-role-definitions";

type MemberAccessRoleWriter = {
  memberAccessRole: Pick<
    Prisma.TransactionClient["memberAccessRole"],
    "createMany"
  >;
  accessRoleDefinition?: Pick<
    Prisma.TransactionClient["accessRoleDefinition"],
    "findMany"
  >;
};

export async function ensureMemberAccessRoles(
  db: MemberAccessRoleWriter,
  params: {
    memberId: string;
    roles: ReadonlyArray<AppAccessRole | string | null | undefined>;
    canLogin?: boolean | null;
    assignedByMemberId?: string | null;
    /** Preloaded definitions (e.g. fetched before a transaction). */
    definitions?: ReadonlyArray<AccessRoleDefinitionRecord>;
  },
) {
  const roles = normalizeAssignableAccessRoleTokens(params.roles, {
    canLogin: params.canLogin,
  });

  if (roles.length === 0) {
    return { count: 0, roles };
  }

  // Dual-write: enum rows are linked to their seeded definition when it
  // exists; definition-id tokens become definition-only rows. Unknown
  // tokens are dropped by the row resolver (callers validate first). When
  // no definitions are reachable, enum rows are written unlinked — the
  // resolver falls back to the legacy bundles and
  // ensureAccessRoleDefinitions re-links them on the next seed run.
  const definitions =
    params.definitions ??
    (db.accessRoleDefinition ? await loadAccessRoleDefinitions(db as Required<MemberAccessRoleWriter>) : []);
  const assignmentRows = accessRoleAssignmentRowsFromTokens(
    roles,
    definitions,
  );

  const assignedByMemberId = params.assignedByMemberId?.trim() || null;
  const result = await db.memberAccessRole.createMany({
    data: assignmentRows.map((row) => ({
      memberId: params.memberId,
      role: row.role,
      roleDefinitionId: row.roleDefinitionId,
      ...(assignedByMemberId ? { assignedByMemberId } : {}),
    })),
    skipDuplicates: true,
  });

  return { count: result.count, roles };
}

export async function ensureMemberAccessRolesFromCompatibilityFields(
  db: MemberAccessRoleWriter,
  params: {
    memberId: string;
    role?: Role | string | null;
    financeAccessLevel?: FinanceAccessLevel | string | null;
    canLogin?: boolean | null;
    assignedByMemberId?: string | null;
  },
) {
  const roles = accessRolesFromCompatibilityFields({
    role: params.role,
    financeAccessLevel: params.financeAccessLevel,
    canLogin: params.canLogin,
  });

  return ensureMemberAccessRoles(db, {
    memberId: params.memberId,
    roles,
    canLogin: params.canLogin,
    assignedByMemberId: params.assignedByMemberId,
  });
}
