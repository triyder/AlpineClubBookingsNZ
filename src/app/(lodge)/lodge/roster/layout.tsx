import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import { hasAnyActiveLodgePinSession } from "@/lib/lodge-pin-session";
import { hasAccessRole, hasLodgeAccess } from "@/lib/access-roles";

export default async function LodgeRosterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (session?.user) {
    if (hasLodgeAccess(session.user)) {
      return <>{children}</>;
    }

    if (
      hasAccessRole(session.user, "USER") &&
      (await hasActiveHutLeaderAssignment(session.user.id))
    ) {
      return <>{children}</>;
    }
  }

  if (await hasAnyActiveLodgePinSession(session?.user?.id ?? null)) {
    return <>{children}</>;
  }

  redirect("/lodge/kiosk");
}
