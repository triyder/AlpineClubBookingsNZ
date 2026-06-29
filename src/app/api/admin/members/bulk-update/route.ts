import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ROLE_VALUES } from "@/lib/member-roles";
import {
  ACCESS_ROLE_VALUES,
  accessRolesFromCompatibilityFields,
  financeAccessLevelFromAccessRoles,
  legacyRoleFromAccessRoles,
  normalizeAssignableAccessRoles,
} from "@/lib/access-roles";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one member ID is required").max(100),
  action: z.enum(["deactivate", "reactivate", "set-role"]),
  role: z.enum(ROLE_VALUES).optional(),
  accessRoles: z.array(z.enum(ACCESS_ROLE_VALUES)).optional(),
}).refine(
  (data) =>
    data.action !== "set-role" ||
    data.role !== undefined ||
    data.accessRoles !== undefined,
  { message: "Role is required for set-role action", path: ["role"] }
);

/**
 * POST /api/admin/members/bulk-update
 * Bulk update members (deactivate, reactivate, or change role).
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bulkUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { ids, action, role, accessRoles } = parsed.data;
  const currentUserId = session.user.id;
  const selfAdminAccessPreserved =
    accessRoles !== undefined
      ? normalizeAssignableAccessRoles(accessRoles, { canLogin: true }).includes(
          "ADMIN",
        )
      : role === "ADMIN";

  // Self-protection checks
  if (action === "deactivate" && ids.includes(currentUserId)) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  if (
    action === "set-role" &&
    !selfAdminAccessPreserved &&
    ids.includes(currentUserId)
  ) {
    return NextResponse.json(
      { error: "You cannot demote your own admin account" },
      { status: 400 }
    );
  }

  try {
    // Find existing members
    const existingMembers = await prisma.member.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        financeAccessLevel: true,
        canLogin: true,
        cancelledAt: true,
        archivedAt: true,
      },
    });

    const existingIds = new Set(existingMembers.map((m) => m.id));
    const notFound = ids.filter((id) => !existingIds.has(id)).length;

    if (action === "reactivate") {
      const blockedMember = existingMembers.find(
        (member) => member.archivedAt || member.cancelledAt,
      );
      if (blockedMember) {
        return NextResponse.json(
          {
            error: blockedMember.archivedAt
              ? "Archived members cannot be reactivated from bulk update"
              : "Cancelled members cannot be reactivated from bulk update",
          },
          { status: 409 },
        );
      }
    }

    // Build update data based on action
    let updateData: Record<string, unknown>;
    switch (action) {
      case "deactivate":
        updateData = { active: false };
        break;
      case "reactivate":
        updateData = { active: true };
        break;
      case "set-role":
        updateData = {};
        break;
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Filter out current user for self-protection
    const idsToUpdate = [...existingIds].filter((id) => {
      if (action === "deactivate" && id === currentUserId) return false;
      if (action === "set-role" && !selfAdminAccessPreserved && id === currentUserId) return false;
      return true;
    });

    // Perform update in transaction
    const result = await prisma.$transaction(async (tx) => {
      const updateResult =
        action === "set-role"
          ? { count: idsToUpdate.length }
          : await tx.member.updateMany({
              where: { id: { in: idsToUpdate } },
              data: updateData,
            });
      if (action === "set-role") {
        for (const member of existingMembers.filter((candidate) =>
          idsToUpdate.includes(candidate.id),
        )) {
          const nextAccessRoles =
            accessRoles !== undefined
              ? normalizeAssignableAccessRoles(accessRoles, {
                  canLogin: member.canLogin,
                })
              : accessRolesFromCompatibilityFields({
                  role,
                  financeAccessLevel:
                    role === "LODGE" ? "NONE" : member.financeAccessLevel,
                  canLogin: member.canLogin,
                });

          await tx.member.update({
            where: { id: member.id },
            data: {
              role:
                accessRoles !== undefined
                  ? legacyRoleFromAccessRoles(nextAccessRoles)
                  : role!,
              financeAccessLevel:
                accessRoles !== undefined
                  ? financeAccessLevelFromAccessRoles(nextAccessRoles)
                  : role === "LODGE"
                    ? "NONE"
                    : member.financeAccessLevel,
            },
          });
          await tx.memberAccessRole.deleteMany({
            where: { memberId: member.id },
          });
          if (nextAccessRoles.length > 0) {
            await tx.memberAccessRole.createMany({
              data: nextAccessRoles.map((nextRole) => ({
                memberId: member.id,
                role: nextRole,
                assignedByMemberId: currentUserId,
              })),
              skipDuplicates: true,
            });
          }
        }
      }
      // Remove family group memberships for deactivated members
      if (action === "deactivate") {
        await tx.familyGroupMember.deleteMany({
          where: { memberId: { in: idsToUpdate } },
        });
      }
      return updateResult;
    });

    // Audit log for each affected member
    for (const member of existingMembers) {
      if (idsToUpdate.includes(member.id)) {
        logAudit({
          action: `member.bulk-${action}`,
          memberId: currentUserId,
          targetId: member.id,
          details: `Bulk ${action}: ${member.firstName} ${member.lastName} (${member.email})${action === "set-role" ? ` -> ${accessRoles?.join(", ") ?? role}` : ""}`,
        });
      }
    }

    return NextResponse.json({
      updated: result.count,
      notFound,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to bulk update members");
    return NextResponse.json({ error: "Failed to bulk update members" }, { status: 500 });
  }
}
