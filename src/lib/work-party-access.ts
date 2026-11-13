import { hasAccessRole, type AccessRoleInput } from "@/lib/access-roles";
import { isOrganisationAccount } from "@/lib/organisation-account";

/**
 * Who sees the member side of work parties (fork #118): the Work Parties
 * dashboard card, the `/work-parties/[id]` page and API, and its "Join Work
 * Party" button. The ONE rule all four use (INV-SSOT).
 *
 * MEMBERS ONLY (owner decision 7, #118). That is narrower than the Events
 * calendar's `canViewCalendarEvents`, which only shuts out organisation
 * accounts, so this is its own helper rather than a reuse of that one.
 *
 * "Member" is the rule the booking-create route already uses to decide whether
 * an account books under member rules: the account holds the `USER` access
 * role (`isMember` in `src/app/api/bookings/route.ts`). That leaves out
 * non-member logins (`NON_MEMBER`, which confers no role), lodge kiosk and
 * admin-only accounts, and any login without club membership. Organisation
 * accounts (the `ORG` role or the legacy `SCHOOL` role) are refused explicitly
 * through `isOrganisationAccount`, the shared organisation check, so the rule
 * still holds for a record that somehow carries both.
 */
export function canViewWorkParties(
  user: AccessRoleInput & { canLogin: boolean },
): boolean {
  return hasAccessRole(user, "USER") && !isOrganisationAccount(user);
}
