import { Activity, Building2, ListChecks, Puzzle } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/setup",
    title: "Setup Checklist",
    description:
      "Review readiness KPIs, blockers, provider tests, and setup progress.",
    icon: ListChecks,
  },
  {
    href: "/admin/modules",
    title: "Modules",
    description:
      "Enable or disable optional club features before opening related workflows.",
    icon: Puzzle,
  },
  {
    href: "/admin/lodges",
    title: "Lodges",
    description:
      "Create and maintain lodge records used by multi-lodge configuration.",
    icon: Building2,
  },
  {
    href: "/admin/health",
    title: "System Health",
    description:
      "Check runtime, database, provider, and background-job readiness.",
    icon: Activity,
  },
];

export default async function FoundationsSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Initial Setup"
      description="Start with first-install readiness, module activation, lodge records, and system health."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup Wizard"
    />
  );
}
