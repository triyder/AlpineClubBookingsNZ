/**
 * Diagnose why a member can (or cannot) manage calendar events.
 *
 *   npx tsx scripts/diagnose-calendar-access.ts someone@example.com
 *
 * Prints the exact inputs to the calendar write gate (src/lib/calendar-access.ts):
 * the member's merged admin-permission matrix (lodge level), their active
 * committee assignments, and the resulting canManage decision — so a
 * "why does this normal user see Edit/Delete?" question has a definitive answer.
 */
import { prisma } from "@/lib/prisma";
import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  hasCalendarManageViaAdmin,
  isActiveCommitteeMember,
} from "@/lib/calendar-access";

async function main() {
  const email = process.argv[2]?.toLowerCase().trim();
  if (!email) {
    console.error("Usage: npx tsx scripts/diagnose-calendar-access.ts <email>");
    process.exit(1);
  }

  const member = await prisma.member.findFirst({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });

  if (!member) {
    console.error(`No member found with email ${email}`);
    process.exit(1);
  }

  const matrix = getAdminPermissionMatrix(member);
  const viaAdmin = hasCalendarManageViaAdmin(member);
  const committee = await isActiveCommitteeMember(member.id);

  const assignments = await prisma.committeeAssignment.findMany({
    where: { memberId: member.id },
    select: {
      isActive: true,
      committeeRole: { select: { name: true, isActive: true } },
    },
  });

  console.log("\n=== Calendar access diagnosis ===");
  console.log("member.id           :", member.id);
  console.log("email               :", member.email);
  console.log("legacy role         :", member.role);
  console.log("canLogin            :", member.canLogin);
  console.log(
    "enum access roles   :",
    member.accessRoles.map((r) => r.role).join(", ") || "(none)",
  );
  console.log("permission matrix   :", matrix);
  console.log("lodge level         :", matrix.lodge);
  console.log("committee assignments:", assignments.length ? assignments : "(none)");
  const canCreate = viaAdmin || committee;
  const canEditDelete = viaAdmin;

  console.log("\n--- gate legs ---");
  console.log("hasCalendarManageViaAdmin (lodge:edit) :", viaAdmin);
  console.log("isActiveCommitteeMember                :", committee);
  console.log(
    "\n>>> canManageCalendarEvents (CREATE) =",
    canCreate,
    canCreate ? "(CAN create)" : "(cannot create)",
  );
  console.log(
    ">>> canEditCalendarEvents  (EDIT/DELETE) =",
    canEditDelete,
    canEditDelete ? "(CAN edit/delete)" : "(cannot edit/delete)",
  );
  console.log(
    viaAdmin
      ? "\nReason: an access role grants lodge:edit (Full Admin / Booking Officer)\n" +
        "— full create, edit, and delete."
      : committee
        ? "\nReason: an active committee assignment under an active role\n" +
          "— create-only. Committee members cannot edit or delete events; only\n" +
          "lodge-edit admins can (see docs/guides/calendar.md)."
        : "\nThis member is read-only. If they still see New event / Edit / Delete,\n" +
          "the app is serving a stale build or a stale session — restart the\n" +
          "server and re-login.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
