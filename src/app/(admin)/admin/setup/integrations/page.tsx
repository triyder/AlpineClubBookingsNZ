import { Activity, MailCheck, Plug, Puzzle, RefreshCw } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure accounting settings used by provider-backed workflows.",
    icon: Plug,
  },
  {
    href: "/admin/xero",
    title: "Xero Sync",
    description:
      "Review operational Xero sync status, mappings, and recent provider activity.",
    icon: RefreshCw,
  },
  {
    href: "/admin/modules",
    title: "Modules",
    description:
      "Enable provider-backed modules only when the club is ready to operate them.",
    icon: Puzzle,
  },
  {
    href: "/admin/email-deliverability",
    title: "Email Deliverability",
    description:
      "Review SES/SMTP delivery state and suppression diagnostics.",
    icon: MailCheck,
  },
  {
    href: "/admin/health",
    title: "Provider Health",
    description:
      "Run safe runtime and provider readiness checks from the health page.",
    icon: Activity,
  },
];

export default async function OperationalIntegrationsSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Operational Integrations"
      description="Check the provider-backed setup pages used by accounting, email, modules, and runtime readiness."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
    />
  );
}
