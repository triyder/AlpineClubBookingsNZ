import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NavBar } from "@/components/nav-bar";
import { SiteBanners } from "@/components/site-banners";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { hasActiveHutLeaderAssignment } from "@/lib/hut-leader";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { clubIdentity } from "@/config/club-identity";
import {
  hasAdminPortalAccess,
  hasFinanceViewerAccess,
} from "@/lib/admin-permissions";
import { hasAccessRole } from "@/lib/access-roles";
import { buildLoginPath } from "@/lib/auth-redirect";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import {
  MEMBER_ONBOARDING_GATE_SELECT,
  isOnboardingGateExemptPath,
  shouldShowMemberOnboarding,
} from "@/lib/member-onboarding";
import { getCurrentSiteBanners } from "@/lib/site-banners";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const requestHeaders = await headers();

  if (!session?.user) {
    // Send the visitor to login, preserving where they were headed so they
    // return there after signing in.
    const requestedPath = requestHeaders.get(REQUEST_PATH_HEADER);
    redirect(buildLoginPath(requestedPath));
  }

  // Check DB directly for force password change and active status (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: MEMBER_ONBOARDING_GATE_SELECT,
  });

  // Redirect deleted/deactivated accounts even if JWT is still valid
  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  const requestedPath = requestHeaders.get(REQUEST_PATH_HEADER);
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

  // Lodge-only accounts can only access /lodge/* routes. Combined access-role
  // accounts continue to their requested member or finance workspace.
  if (
    hasAccessRole(member, "LODGE") &&
    !hasAccessRole(member, "USER") &&
    !hasFinanceViewerAccess(member)
  ) {
    redirect("/lodge/kiosk");
  }

  const isHutLeaderActive =
    hasAccessRole(member, "USER")
      ? await hasActiveHutLeaderAssignment(session.user.id)
      : false;

  // Check if the member is a staying guest (PAID booking where checkIn-1 <= today <= checkOut)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let isStayingGuest = false;
  if (
    hasAccessRole(member, "USER") &&
    !isHutLeaderActive
  ) {
    const stayingBooking = await prisma.booking.findFirst({
      where: {
        memberId: session.user.id,
        deletedAt: null,
        status: "PAID",
        checkIn: { lte: tomorrow },
        checkOut: { gte: today },
      },
      select: { id: true },
    });
    isStayingGuest = !!stayingBooking;
  }

  const user = {
    name: session.user.name ?? "Member",
    email: session.user.email ?? "",
    role: member.role,
    canAccessAdmin: hasAdminPortalAccess(member),
    canAccessFinance: hasFinanceViewerAccess(member),
    isHutLeader: isHutLeaderActive,
    isStayingGuest,
  };
  // Single-action token routes (e.g. `/nominations/<token>`) are exempt from the
  // mandatory onboarding gate so a member can complete that action without first
  // being forced to supply their own profile details. The gate is unchanged for
  // every normal authenticated route.
  const showOnboardingWizard =
    shouldShowMemberOnboarding(member) &&
    !isOnboardingGateExemptPath(requestedPath);
  const [effectiveModules, lodgeCapacity, siteBanners] = await Promise.all([
    loadEffectiveModuleFlags(),
    // Default lodge: this layout's capacity feeds club identity copy
    // (per-lodge figures come from lodge-scoped surfaces).
    getDefaultLodgeCapacity(),
    getCurrentSiteBanners(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div className="app-theme-scope min-h-screen flex flex-col bg-background text-foreground">
        <SiteBanners banners={siteBanners} />
        <NavBar user={user} features={effectiveModules} />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
        <MemberOnboardingWizard initialShouldShow={showOnboardingWizard} />
        <ReportIssueWidget />
      </div>
    </AppProviders>
  );
}
