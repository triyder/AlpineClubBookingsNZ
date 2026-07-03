import type { FinanceAccessLevel, Prisma, Role } from "@prisma/client";
import {
  accessRolesFromCompatibilityFields,
  normalizeAssignableAccessRoleTokens,
  type AppAccessRole,
} from "@/lib/access-roles";
import {
  accessRoleAssignmentRowsFromTokens,
  loadAccessRoleDefinitions,
} from "@/lib/access-role-definitions";

type MemberAccessRoleWriter = {
  memberAccessRole: Pick<
    Prisma.TransactionClient["memberAccessRole"],
    "createMany"
  >;
  accessRoleDefinition: Pick<
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
  // tokens are dropped by the row resolver (callers validate first).
  const definitions = await loadAccessRoleDefinitions(db);
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
