// Pure helpers for the Partner/Husband/Wife relationship (#1742), kept in a
// leaf module with no side-effecting imports ("server-only", prisma, email,
// audit) so predicates like double-bed-sharing.ts — and any test suite whose
// module graph reaches them — can use the canonical pair ordering and status
// vocabulary without pulling in the full service graph (#1744).

export const PARTNER_LINK_PENDING = "PENDING";
export const PARTNER_LINK_CONFIRMED = "CONFIRMED";

/** Canonical pair ordering: the lower member id is always memberAId. */
export function canonicalPartnerPair(memberOneId: string, memberTwoId: string) {
  return memberOneId < memberTwoId
    ? { memberAId: memberOneId, memberBId: memberTwoId }
    : { memberAId: memberTwoId, memberBId: memberOneId };
}
