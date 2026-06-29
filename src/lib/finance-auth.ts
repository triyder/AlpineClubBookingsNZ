import type { Role } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  hasLodgeAccess,
  hasFinanceManagerAccess as hasFinanceManagerRoleAccess,
  hasFinanceViewerAccess as hasFinanceViewerRoleAccess,
  type AccessRoleInput,
  type AppAccessRole,
} from "@/lib/access-roles";
import { buildLoginPath } from "@/lib/auth-redirect";
import { prisma } from "@/lib/prisma";

export type FinanceAccessMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  accessRoles: Array<{ role: AppAccessRole }>;
  active: boolean;
  forcePasswordChange: boolean;
};

export function hasFinanceViewerAccess(input: AccessRoleInput) {
  return hasFinanceViewerRoleAccess(input);
}

export function hasFinanceManagerAccess(input: AccessRoleInput) {
  return hasFinanceManagerRoleAccess(input);
}

export async function loadFinanceAccessMember(
  memberId: string
): Promise<FinanceAccessMember | null> {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      accessRoles: { select: { role: true } },
      active: true,
      forcePasswordChange: true,
    },
  });
}

export async function requireFinanceViewer(
  callbackPath: string = "/finance"
): Promise<FinanceAccessMember> {
  const session = await auth();

  if (!session?.user) {
    redirect(buildLoginPath(callbackPath));
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  if (!hasFinanceViewerAccess(member)) {
    if (hasLodgeAccess(member)) {
      redirect("/lodge/kiosk");
    }
    redirect("/dashboard");
  }

  return member;
}

export async function requireFinanceManager(
  callbackPath: string = "/finance"
): Promise<FinanceAccessMember> {
  const member = await requireFinanceViewer(callbackPath);

  if (!hasFinanceManagerAccess(member)) {
    redirect("/finance");
  }

  return member;
}
