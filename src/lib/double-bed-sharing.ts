import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type DoubleBedSharingDb = typeof prisma | Prisma.TransactionClient;

/**
 * Whether two members may share one DOUBLE bed for a night (#1701).
 *
 * v1 signal = "declared partners", modelled as two ADULT members who belong to
 * the same FamilyGroup — there is no dedicated member-to-member partner model
 * yet (that is #1682, being built separately). This is the **single source of
 * truth** for the who-may-share rule: admin-board placement and the board UI
 * both go through here, so when #1682's real partner relationship lands, only
 * this function body changes (swap the same-FamilyGroup test for the partner
 * check) — not the placement/UI/capacity code around it.
 *
 * Deliberately strict: both ids must resolve to real members, be distinct, and
 * be ageTier ADULT (no minor may be a declared partner in v1), and the two must
 * share at least one FamilyGroup. Anything else returns false so the caller can
 * reject the placement with a clear domain error.
 */
export async function mayShareDoubleBed(
  memberIdA: string,
  memberIdB: string,
  db: DoubleBedSharingDb = prisma,
): Promise<boolean> {
  if (!memberIdA || !memberIdB || memberIdA === memberIdB) return false;

  const members = await db.member.findMany({
    where: { id: { in: [memberIdA, memberIdB] } },
    select: {
      id: true,
      ageTier: true,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  });

  // Both ids must resolve to distinct, existing members.
  if (members.length !== 2) return false;

  // v1: only two adults may be declared partners.
  if (!members.every((member) => member.ageTier === "ADULT")) return false;

  // They must co-belong to at least one FamilyGroup (the declared-partner
  // signal until #1682). Intersection is symmetric, so member order is
  // irrelevant.
  const [first, second] = members;
  const firstGroupIds = new Set(
    first.familyGroupMemberships.map((membership) => membership.familyGroupId),
  );
  return second.familyGroupMemberships.some((membership) =>
    firstGroupIds.has(membership.familyGroupId),
  );
}
