import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ROLE_VALUES } from "@/lib/member-roles";
import {
  accessRoleChangeRequiresFullAdmin,
  accessRolesFromCompatibilityFields,
  isFullAdmin,
  legacyRoleFromAccessRoles,
  memberHoldsPrivilegedRole,
  normalizeAssignableAccessRoleTokens,
  resolveAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
} from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_BULK_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveAllFullAdmins,
} from "@/lib/admin-account-guards";
import {
  accessRoleAssignmentRowsFromTokens,
  findUnknownAccessRoleTokens,
  loadAccessRoleDefinitions,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import {
  financeAccessLevelFromMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocations,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one member ID is required").max(100),
  action: z.enum(["deactivate", "reactivate", "set-role"]),
  role: z.enum(ROLE_VALUES).optional(),
  accessRoles: z.array(z.string().trim().min(1).max(120)).optional(),
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

  const roleDefinitions = await loadAccessRoleDefinitions(prisma);
  if (accessRoles !== undefined) {
    const unknownTokens = findUnknownAccessRoleTokens(
      accessRoles,
      roleDefinitions,
    );
    if (unknownTokens.length > 0) {
      return NextResponse.json(
        { error: `Unknown access role: ${unknownTokens.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const selfAdminAccessPreserved =
    accessRoles !== undefined
      ? normalizeAssignableAccessRoleTokens(accessRoles, {
          canLogin: true,
        }).includes("ADMIN")
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
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
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

    const setRoleTargets =
      action === "set-role"
        ? existingMembers
            .filter((candidate) => idsToUpdate.includes(candidate.id))
            .map((member) => ({
              member,
              nextAccessRoles:
                accessRoles !== undefined
                  ? normalizeAssignableAccessRoleTokens(accessRoles, {
                      canLogin: member.canLogin,
                    })
                  : accessRolesFromCompatibilityFields({
                      role,
                      financeAccessLevel:
                        role === "LODGE" ? "NONE" : member.financeAccessLevel,
                      canLogin: member.canLogin,
                    }),
            }))
        : [];

    // Full Admin gate (issue #1012): only a Full Admin may grant or revoke
    // privileged access roles. Compare both the effective roles
    // (canLogin-aware) and the stored role fields (canLogin-blind) so a
    // scoped admin can neither change live privileged access nor park a
    // dormant elevated role for later activation.
    if (
      !isFullAdmin(session.user) &&
      setRoleTargets.some(({ member, nextAccessRoles }) => {
        const storedAfter =
          accessRoles !== undefined
            ? normalizeAssignableAccessRoleTokens(accessRoles, {
                canLogin: true,
              })
            : accessRolesFromCompatibilityFields({
                role,
                financeAccessLevel:
                  role === "LODGE" ? "NONE" : member.financeAccessLevel,
                canLogin: true,
              });
        return (
          accessRoleChangeRequiresFullAdmin(
            resolveAccessRoleTokens(member),
            nextAccessRoles,
          ) ||
          accessRoleChangeRequiresFullAdmin(
            storedAccessRolesForFullAdminGate(member),
            storedAfter,
          )
        );
      })
    ) {
      return NextResponse.json(
        { error: "Only a Full Admin can change member access roles" },
        { status: 403 },
      );
    }

    // Privileged-target guard (issue #1604): only a Full Admin may
    // bulk-deactivate accounts that hold (or dormantly store) a privileged
    // access role, consistent with the #1012 role gate above.
    if (
      action === "deactivate" &&
      !isFullAdmin(session.user) &&
      existingMembers.some(
        (member) =>
          idsToUpdate.includes(member.id) && memberHoldsPrivilegedRole(member),
      )
    ) {
      return NextResponse.json(
        { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
        { status: 403 },
      );
    }

    // #1756: shared-double placements swept by a deactivate, collected inside
    // the transaction and alerted on after commit.
    const sweptSharesByMember: Array<{
      memberId: string;
      swept: SweptPartnerSharedAllocation[];
    }> = [];

    // Perform update in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Last-admin end-state guard (issue #1604): evaluate the whole set, not
      // per row, so a bulk deactivate that collectively removes every
      // remaining Full Admin fails as a whole. Counted inside the transaction
      // for the mutation's read view.
      if (
        action === "deactivate" &&
        (await wouldRemoveAllFullAdmins(tx, idsToUpdate))
      ) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_BULK_GUARD_MESSAGE);
      }

      const updateResult =
        action === "set-role"
          ? { count: idsToUpdate.length }
          : await tx.member.updateMany({
              where: { id: { in: idsToUpdate } },
              data: updateData,
            });
      if (action === "set-role") {
        for (const { member, nextAccessRoles } of setRoleTargets) {
          await tx.member.update({
            where: { id: member.id },
            data: {
              role:
                accessRoles !== undefined
                  ? legacyRoleFromAccessRoles(nextAccessRoles)
                  : role!,
              financeAccessLevel:
                accessRoles !== undefined
                  ? financeAccessLevelFromMatrix(
                      getAdminPermissionMatrix({
                        accessRoles: accessRoleAssignmentRowsFromTokens(
                          nextAccessRoles,
                          roleDefinitions,
                        ),
                        canLogin: true,
                      }),
                    )
                  : role === "LODGE"
                    ? "NONE"
                    : member.financeAccessLevel,
            },
          });
          const assignmentRows = accessRoleAssignmentRowsFromTokens(
            nextAccessRoles,
            roleDefinitions,
          );
          await tx.memberAccessRole.deleteMany({
            where: { memberId: member.id },
          });
          if (assignmentRows.length > 0) {
            await tx.memberAccessRole.createMany({
              data: assignmentRows.map((row) => ({
                memberId: member.id,
                role: row.role,
                roleDefinitionId: row.roleDefinitionId,
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
        // #1756: deactivation breaks the double-bed sharing precondition, so
        // sweep each member's future shared-double placements in the same
        // transaction (idempotent; a member holding no shares is a no-op).
        // The removed second occupants return to the awaiting-allocation
        // queue; admins are alerted per affected member after commit.
        for (const memberId of idsToUpdate) {
          const swept = await sweepFuturePartnerSharedAllocations({
            memberId,
            reason: "member_deactivated",
            db: tx,
          });
          if (swept.length > 0) {
            sweptSharesByMember.push({ memberId, swept });
          }
        }
      }
      return updateResult;
    });

    for (const { memberId, swept } of sweptSharesByMember) {
      const member = existingMembers.find((m) => m.id === memberId);
      // Post-commit, fire-and-forget: a failed alert only loses the nudge —
      // the sweep committed with the deactivation and both bookings carry
      // audit rows.
      sendAdminPartnerShareSweptAlert({
        memberName: member
          ? `${member.firstName} ${member.lastName}`.trim()
          : memberId,
        partnerName: partnerShareSweepCounterpartNames(swept, memberId),
        reason: describePartnerSharedSweepReason("member_deactivated"),
        nights: partnerShareSweepNights(swept),
      }).catch((err) => {
        logger.error(
          { err, memberId, sweptCount: swept.length },
          "Failed to send partner share sweep alert",
        );
      });
    }

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
    if (error instanceof AdminAccountGuardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error({ err: error }, "Failed to bulk update members");
    return NextResponse.json({ error: "Failed to bulk update members" }, { status: 500 });
  }
}
