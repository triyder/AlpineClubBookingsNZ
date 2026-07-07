import { prisma } from "@/lib/prisma";

export type ResolvedFamilyRelationship = "self" | "partner" | "dependent";

export type ResolvedFamilyMember = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  relationship: ResolvedFamilyRelationship;
};

export type ResolvedMemberFamily = {
  familyGroupId: string | null;
  familyGroupName: string | null;
  familyGroupIds: string[];
  familyMembers: ResolvedFamilyMember[];
};

/**
 * Resolve a member's own record plus every active member of the family
 * group(s) they belong to, shaped for the admin booking-on-behalf family
 * picker. Returns null when the member does not exist, is inactive, or is
 * archived (callers surface that as a 404).
 *
 * This is the single implementation shared by every on-behalf family picker
 * so they all return the SAME shape regardless of which permission gate the
 * calling route enforces (issue #1376):
 *   - GET /api/admin/members/[id]/family            (gated membership:view)
 *   - GET /api/admin/bookings/[id]/eligible-family  (gated bookings:edit)
 *   - GET /api/admin/bookings/eligible-family       (gated bookings:edit)
 *
 * It intentionally exposes exactly ONE member's family group per call — never a
 * directory enumeration — so a bookings:edit actor can attach the correct
 * member identity (→ correct member pricing) for the single member they are
 * booking on-behalf-of, even without membership:view.
 */
export async function resolveMemberFamily(
  memberId: string,
): Promise<ResolvedMemberFamily | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      active: true,
      archivedAt: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!member || !member.active || member.archivedAt) {
    return null;
  }

  const seen = new Set<string>();
  const familyMembers: ResolvedFamilyMember[] = [];

  function addMember(
    m: { id: string; firstName: string; lastName: string; ageTier: string },
    relationship: ResolvedFamilyRelationship,
  ) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    familyMembers.push({ ...m, relationship });
  }

  // Include the target member as "self".
  addMember(
    {
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
    },
    "self",
  );

  // All active members from the target member's family groups.
  const groupIds = member.familyGroupMemberships.map((m) => m.familyGroupId);

  if (groupIds.length > 0) {
    const groupMemberships = await prisma.familyGroupMember.findMany({
      where: {
        familyGroupId: { in: groupIds },
        memberId: { not: memberId },
        member: { active: true, archivedAt: null },
      },
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, ageTier: true },
        },
      },
      orderBy: { member: { firstName: "asc" } },
    });
    for (const gm of groupMemberships) {
      const rel = gm.member.ageTier === "ADULT" ? "partner" : "dependent";
      addMember(gm.member, rel);
    }
  }

  const firstGroup = member.familyGroupMemberships[0]?.familyGroup ?? null;

  return {
    familyGroupId: firstGroup?.id ?? null,
    familyGroupName: firstGroup?.name ?? null,
    familyGroupIds: groupIds,
    familyMembers,
  };
}
