/**
 * The family a member is billed through for a PER_FAMILY fee (#1932, E6).
 *
 * One rule, used by the billing preview's main loop (which turns each refusal
 * into its own exception) and by its closed-family reversal check (#4110
 * review: only members whose billing family is still the closed charge's
 * family count toward re-billing it):
 *
 *  - no family -> NONE;
 *  - exactly one family -> that one (the selection is ignored);
 *  - several families -> the admin-chosen `billingFamilyGroupId`, when it is
 *    still one of them (INVALID_SELECTION when it is not, AMBIGUOUS when none
 *    was chosen).
 */
export type BillingFamilyResolution<M> =
  | { kind: "NONE" }
  | { kind: "AMBIGUOUS" }
  | { kind: "INVALID_SELECTION" }
  | { kind: "RESOLVED"; membership: M };

export function resolveBillingFamilyMembership<M extends { familyGroupId: string }>(member: {
  familyGroupMemberships: readonly M[];
  billingFamilyGroupId: string | null;
}): BillingFamilyResolution<M> {
  const [first] = member.familyGroupMemberships;
  if (first === undefined) return { kind: "NONE" };
  if (member.familyGroupMemberships.length === 1) return { kind: "RESOLVED", membership: first };
  if (!member.billingFamilyGroupId) return { kind: "AMBIGUOUS" };
  const selected = member.familyGroupMemberships.find((row) => row.familyGroupId === member.billingFamilyGroupId);
  return selected ? { kind: "RESOLVED", membership: selected } : { kind: "INVALID_SELECTION" };
}

/** True when the member is billed through `familyGroupId` under that rule. */
export function isBilledThroughFamily(
  member: { familyGroupMemberships: readonly { familyGroupId: string }[]; billingFamilyGroupId: string | null },
  familyGroupId: string | null,
): boolean {
  const resolution = resolveBillingFamilyMembership(member);
  return resolution.kind === "RESOLVED" && resolution.membership.familyGroupId === familyGroupId;
}
