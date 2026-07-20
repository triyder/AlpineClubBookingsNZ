import { headers } from "next/headers";
import { AppProviders } from "@/components/app-providers";
import { ContextualHelpButton } from "@/components/contextual-help-button";
import { Badge } from "@/components/ui/badge";
import { NavBar } from "@/components/nav-bar";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  hasFinanceManagerAccess,
  requireFinanceViewer,
} from "@/lib/finance-auth";
import { hasAdminPortalAccess } from "@/lib/admin-permissions";

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const member = await requireFinanceViewer("/finance");
  const fullName = `${member.firstName} ${member.lastName}`.trim() || "Member";
  const isManager = hasFinanceManagerAccess(member);
  const [effectiveModules, lodgeCapacity, theme, clubIdentity] = await Promise.all([
    loadEffectiveModuleFlags(),
    getDefaultLodgeCapacity(),
    getWebsiteThemeRenderState(),
    getCachedClubIdentity(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope min-h-screen flex flex-col bg-background text-foreground`}
      >
        <style
          dangerouslySetInnerHTML={{ __html: theme.appCss }}
          data-site-style="club-theme"
        />
        <NavBar
          features={effectiveModules}
          user={{
            name: fullName,
            email: member.email,
            role: member.role,
            canAccessAdmin: hasAdminPortalAccess(member),
            canAccessFinance: true,
          }}
        />
        <main className="reports-print-root flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col gap-3 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Finance
              </p>
              <h1 className="text-3xl font-semibold text-foreground">
                {liveClubIdentity.name} finance workspace
              </h1>
              <p className="text-sm text-muted-foreground">
                Review finance reports, booking performance, and sync status in
                one place.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={isManager ? "default" : "secondary"}>
                {isManager ? "Finance manager" : "Finance viewer"}
              </Badge>
              <ContextualHelpButton scope="finance" />
            </div>
          </div>
          {children}
        </main>
        <ReportIssueWidget />
      </div>
    </AppProviders>
  );
}
