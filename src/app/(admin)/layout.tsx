import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AdminSidebar } from "@/components/admin-sidebar";
import { ContextualHelpButton } from "@/components/contextual-help-button";
import { NavBar } from "@/components/nav-bar";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { clubIdentity } from "@/config/club-identity";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { isFullAdmin } from "@/lib/access-roles";
import {
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  getFirstAccessibleAdminHref,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  hasFinanceViewerAccess,
} from "@/lib/admin-permissions";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { isClubThemeComplete } from "@/lib/club-theme";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import {
  MEMBER_ONBOARDING_GATE_SELECT,
  shouldShowMemberOnboarding,
} from "@/lib/member-onboarding";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import { recordAuthBounce } from "@/lib/auth-diagnostics";
import { buildLoginPath } from "@/lib/auth-redirect";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const requestHeaders = await headers();

  if (!session?.user) {
    // recordAuthBounce (#1669) classifies WHY auth() nulled and returns a
    // reference code for durable bounces; it never throws, and the extra
    // .catch guarantees the redirect even if that contract ever regresses.
    // Anonymous visits keep the historical bare /login target.
    const bounceRequestedPath = requestHeaders.get(REQUEST_PATH_HEADER);
    const authBounceRef = await recordAuthBounce({
      layout: "admin",
      requestedPath: bounceRequestedPath,
    }).catch(() => null);
    redirect(authBounceRef ? buildLoginPath(null, authBounceRef) : "/login");
  }

  // Check DB directly for force password change and active status (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: MEMBER_ONBOARDING_GATE_SELECT,
  });

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

  const adminRequirement =
    getAdminRouteRequirement(requestedPath ?? "/admin/dashboard", "GET") ?? {
      area: "overview" as const,
      level: "view" as const,
    };

  if (!hasAdminAreaAccess(member, adminRequirement)) {
    redirect(getFirstAccessibleAdminHref(member) ?? "/dashboard");
  }

  const user = {
    name: session.user.name ?? "Admin",
    email: session.user.email ?? "",
    role: member.role,
    canAccessAdmin: hasAdminPortalAccess(member),
    canAccessFinance: hasFinanceViewerAccess(member),
    isHutLeader: false,
    isStayingGuest: false,
  };
  // Precomputed server-side: the sidebar is a client component and cannot
  // resolve database-backed role definitions itself.
  const permissionMatrix = getAdminPermissionMatrix(member);
  const actorIsFullAdmin = isFullAdmin(member);
  const canManageContent = hasAdminAreaAccess(member, {
    area: "content",
    level: "edit",
  });
  const showOnboardingWizard = shouldShowMemberOnboarding(member);
  const [effectiveModules, siteStyleComplete, lodgeCapacity] =
    await Promise.all([
      loadEffectiveModuleFlags(),
      isClubThemeComplete(),
      getDefaultLodgeCapacity(),
    ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope min-h-screen flex flex-col bg-background text-foreground`}
      >
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          Skip to main content
        </a>
        <NavBar user={user} features={effectiveModules} />
        <div className="flex flex-1">
          <AdminSidebar
            features={effectiveModules}
            permissionMatrix={permissionMatrix}
            isFullAdmin={actorIsFullAdmin}
            hutLeaderLabel={liveClubIdentity.hutLeaderLabel}
          />
          <div className="flex flex-1 flex-col md:overflow-hidden">
            <main
              id="main-content"
              className="flex-1 overflow-y-auto p-6 pb-24 print:overflow-visible print:p-0 md:p-8 md:pb-28"
            >
              <div className="mb-4 flex justify-end print:hidden">
                <ContextualHelpButton scope="admin" />
              </div>
              {!siteStyleComplete && canManageContent && (
                <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-medium">
                      Complete your site style before opening the public website.
                    </p>
                    <Link
                      href="/admin/site-style"
                      className="rounded-md bg-brand-gold px-3 py-2 text-sm font-semibold text-brand-charcoal shadow-sm transition-colors hover:bg-brand-gold/90"
                    >
                      Open Site Style
                    </Link>
                  </div>
                </div>
              )}
              {children}
            </main>
          </div>
        </div>
        <MemberOnboardingWizard initialShouldShow={showOnboardingWizard} />
        <ReportIssueWidget avoidDesktopSidebar />
      </div>
    </AppProviders>
  );
}
