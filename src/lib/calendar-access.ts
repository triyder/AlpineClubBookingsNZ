import { prisma } from "@/lib/prisma";
import {
  hasAdminAreaAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";

/**
 * Write access to the club events calendar (#calendar).
 *
 * Two audiences may add / edit / delete events, deliberately asymmetric with
 * how the rest of the admin surface is gated:
 *
 * - **Full Admins** (anyone whose merged permission matrix grants `lodge:edit`)
 *   — the calendar lives under Admin → Lodge Operations, so it inherits the
 *   lodge area's edit level exactly like Work Parties or Roster.
 * - **Committee members** — any member holding at least one ACTIVE
 *   `CommitteeAssignment` under an ACTIVE `CommitteeRole`. Committee assignment
 *   normally grants NO app privileges (it is public contact metadata, see
 *   CONFIGURATION.md → Committee Settings); the calendar is the one deliberate
 *   exception, per the feature owner's requirement that committee members
 *   manage events without being made Full Admins.
 *
 * Everyone else who can log in is read-only. The gate is enforced server-side
 * in every calendar write route and mirrored into the UI (canManage) so the
 * controls a member cannot use are never shown.
 */
export async function isActiveCommitteeMember(
  memberId: string,
): Promise<boolean> {
  const assignment = await prisma.committeeAssignment.findFirst({
    where: {
      memberId,
      isActive: true,
      committeeRole: { isActive: true },
    },
    select: { id: true },
  });
  return assignment !== null;
}

/** Admin-side leg of the calendar write gate: lodge-area edit. */
export function hasCalendarManageViaAdmin(input: AdminPermissionInput): boolean {
  return hasAdminAreaAccess(input, { area: "lodge", level: "edit" });
}

/**
 * True when this member may add / edit / delete calendar events — a Full Admin
 * with `lodge:edit`, OR an active committee member. Reads the committee table
 * only when the admin leg does not already grant access.
 */
export async function canManageCalendarEvents(
  input: AdminPermissionInput & { id: string },
): Promise<boolean> {
  if (hasCalendarManageViaAdmin(input)) return true;
  return isActiveCommitteeMember(input.id);
}
