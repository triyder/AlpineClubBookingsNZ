/**
 * Sentinel value for the members-list "Membership Type" filter that matches
 * members with no current-season SeasonalMembershipAssignment. Shared by the
 * toolbar (client), the list/export services (server), and their tests so the
 * three agree on one token. Real MembershipType ids are cuids, so this literal
 * cannot collide with a genuine id.
 */
export const UNASSIGNED_MEMBERSHIP_TYPE_VALUE = "UNASSIGNED";
