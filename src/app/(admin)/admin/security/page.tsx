import type { Metadata } from "next";
import { MagicLinkSecurityCard } from "@/components/admin/magic-link-security-card";
import { PasswordPolicyCard } from "@/components/admin/security/password-policy-card";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import { loadClubModuleSettings } from "@/lib/module-settings";

// Login & Security admin page (epic #2030, child #2033). Scaffolds the page and
// hosts the password-policy card and the magic-link sign-in card (#2034). The
// remaining sibling (Google sign-in, #2035) adds a self-contained card below
// with no churn here.
// Route access is governed by the `support` admin area (see admin-permissions.ts).

export const metadata: Metadata = {
  title: "Login & Security",
};

export default async function AdminSecurityPage() {
  const [{ settings: moduleSettings }, loginSecurity] = await Promise.all([
    loadClubModuleSettings(),
    loadLoginSecuritySettings(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Login &amp; Security</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Control how members sign in and how strong their passwords must be.
          These settings apply across the club.
        </p>
      </div>

      <div className="grid gap-6">
        <PasswordPolicyCard />
        <MagicLinkSecurityCard
          moduleSettings={moduleSettings}
          initialTtlMinutes={loginSecurity.policy.magicLinkTtlMinutes}
        />
      </div>
    </div>
  );
}
