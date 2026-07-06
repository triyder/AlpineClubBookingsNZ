import { Plug } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const sections: AdminHubSection[] = [
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure the accounting settings used by finance workflows.",
    icon: Plug,
  },
];

export default async function IntegrationsHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Integrations"
      description="Configure connected services used by accounting and other provider-backed workflows."
      sections={sections}
      features={features}
    />
  );
}
