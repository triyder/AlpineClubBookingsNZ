import { prisma } from "@/lib/prisma";
import {
  canonicalPartnerPair,
  PARTNER_LINK_CONFIRMED,
} from "@/lib/member-partner-link-shared";

// Structural minimum rather than `typeof prisma | Prisma.TransactionClient`:
// callers hold differently-Omitted transaction clients (e.g. capacity.ts's,
// #1745), and all this module needs are these two delegates.
type DoubleBedSharingDb = Pick<typeof prisma, "member" | "memberPartnerLink">;

/**
 * Whether two members may share one DOUBLE bed for a night (#1701).
 *
 * The signal is a CONFIRMED Partner/Husband/Wife relationship — a
 * `MemberPartnerLink` row (#1742). #1744 swapped this in for the interim v1
 * rule (two ADULT members sharing a FamilyGroup), which wrongly permitted
 * e.g. a parent and an adult child to share. This is the **single source of
 * truth** for the who-may-share rule: admin-board placement and the board UI
 * both go through here, so the eligibility signal changes only in this
 * function body — not in the placement/UI/capacity code around it.
 *
 * Deliberately strict: both ids must resolve to real, ACTIVE members, be
 * distinct, and be ageTier ADULT (links are ADULT-only and active-only at
 * creation; both re-checked here so a later tier correction or deactivation
 * blocks new placements even while a stale link row survives), and the pair
 * must hold a CONFIRMED link — a PENDING request grants nothing. Anything
 * else returns false so the caller can reject the placement with a clear
 * domain error. This gates NEW placements only: already-placed second
 * occupants are not swept when a link dissolves or a member is deactivated
 * (#1756).
 */
export interface PartnerSharingCandidate {
  id: string;
  firstName: string;
  lastName: string;
  partnerOfMemberId: string;
  partnerOfName: string;
}

/**
 * Confirmed partners of the member guests already on a booking who could be
 * added as partner-sharers (#1746): active ADULT members holding a CONFIRMED
 * link with a booking member, and not themselves a guest on the booking yet.
 * Server-computed so the admin edit UI renders policy rather than
 * re-implementing it; the admission path (mayShareDoubleBed +
 * checkCapacityForPartnerSharedAdmission) still re-validates at apply time.
 */
export async function listBookingPartnerSharingCandidates(
  bookingId: string,
  db: Pick<typeof prisma, "bookingGuest" | "memberPartnerLink" | "member"> = prisma,
): Promise<PartnerSharingCandidate[]> {
  const memberGuests = await db.bookingGuest.findMany({
    where: { bookingId, memberId: { not: null } },
    select: { memberId: true, firstName: true, lastName: true },
  });
  const guestMemberIds = [
    ...new Set(
      memberGuests
        .map((guest) => guest.memberId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (guestMemberIds.length === 0) return [];

  const links = await db.memberPartnerLink.findMany({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      OR: [
        { memberAId: { in: guestMemberIds } },
        { memberBId: { in: guestMemberIds } },
      ],
    },
    select: { memberAId: true, memberBId: true },
  });
  if (links.length === 0) return [];

  const guestIdSet = new Set(guestMemberIds);
  // Candidate id -> the booking member they share with. At most one confirmed
  // partner per member, so a candidate maps to exactly one anchor; a link
  // whose both sides are already booking guests offers no candidate.
  const candidateToAnchor = new Map<string, string>();
  for (const link of links) {
    const [inBooking, other] = guestIdSet.has(link.memberAId)
      ? [link.memberAId, link.memberBId]
      : [link.memberBId, link.memberAId];
    if (!guestIdSet.has(other)) {
      candidateToAnchor.set(other, inBooking);
    }
  }
  if (candidateToAnchor.size === 0) return [];

  const candidates = await db.member.findMany({
    where: {
      id: { in: [...candidateToAnchor.keys()] },
      active: true,
      ageTier: "ADULT",
    },
    select: { id: true, firstName: true, lastName: true },
  });
  const anchorName = (anchorId: string) => {
    const anchor = memberGuests.find((guest) => guest.memberId === anchorId);
    return anchor ? `${anchor.firstName} ${anchor.lastName}`.trim() : "";
  };

  return candidates.map((candidate) => {
    const anchorId = candidateToAnchor.get(candidate.id) as string;
    return {
      id: candidate.id,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      partnerOfMemberId: anchorId,
      partnerOfName: anchorName(anchorId),
    };
  });
}

export async function mayShareDoubleBed(
  memberIdA: string,
  memberIdB: string,
  db: DoubleBedSharingDb = prisma,
): Promise<boolean> {
  if (!memberIdA || !memberIdB || memberIdA === memberIdB) return false;

  const members = await db.member.findMany({
    where: { id: { in: [memberIdA, memberIdB] } },
    select: { ageTier: true, active: true },
  });

  // Both ids must resolve to distinct, existing members.
  if (members.length !== 2) return false;

  // Only two active adults may share a double.
  if (!members.every((member) => member.ageTier === "ADULT" && member.active)) {
    return false;
  }

  // The link row is a canonical ordered pair (memberAId < memberBId), so one
  // indexed unique lookup covers both argument orders.
  const link = await db.memberPartnerLink.findUnique({
    where: { memberAId_memberBId: canonicalPartnerPair(memberIdA, memberIdB) },
    select: { status: true },
  });
  return link?.status === PARTNER_LINK_CONFIRMED;
}
