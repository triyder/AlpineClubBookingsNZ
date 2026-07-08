import { redirect } from "next/navigation";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { auth } from "@/lib/auth";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";

export async function loadAdminSetupPermissionMatrix() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });

  return member
    ? getAdminPermissionMatrix(member)
    : emptyAdminPermissionMatrix();
}
