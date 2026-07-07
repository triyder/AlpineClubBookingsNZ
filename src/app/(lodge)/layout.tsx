import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { auth } from "@/lib/auth";
import { clubIdentity } from "@/config/club-identity";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { prisma } from "@/lib/prisma";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

export default async function LodgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const requestHeaders = await headers();

  if (!session?.user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/lodge/kiosk")}`);
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      active: true,
      forcePasswordChange: true,
      twoFactorEnabled: true,
    },
  });

  if (!member?.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  const requestedPath =
    requestHeaders.get(REQUEST_PATH_HEADER) ?? "/lodge/kiosk";
  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    redirect(
      buildTwoFactorGatePath({
        sessionUser: session.user,
        member,
        callbackPath: requestedPath,
      }),
    );
  }

  const lodgeCapacity = await getDefaultLodgeCapacity();
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div className="app-theme-scope min-h-screen bg-background text-foreground">
        {children}
      </div>
    </AppProviders>
  );
}
