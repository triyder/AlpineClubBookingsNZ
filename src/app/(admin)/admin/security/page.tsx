import type { Metadata } from "next";
import { PasswordPolicyCard } from "@/components/admin/security/password-policy-card";

// Login & Security admin page (epic #2030, child #2033). Scaffolds the page and
// hosts the password-policy card today. The sibling issues add self-contained
// magic-link (#2034) and Google sign-in (#2035) cards below with no churn here.
// Route access is governed by the `support` admin area (see admin-permissions.ts).

export const metadata: Metadata = {
  title: "Login & Security",
};

export default function AdminSecurityPage() {
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
      </div>
    </div>
  );
}
