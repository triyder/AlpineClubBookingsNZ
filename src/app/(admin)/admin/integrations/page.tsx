import { Plug } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getIntegrationsNeedingReentry } from "@/lib/integration-credentials";

const sections: AdminHubSection[] = [
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure the accounting settings used by finance workflows.",
    icon: Plug,
  },
];

const BASE_DESCRIPTION =
  "Configure connected services used by accounting and other provider-backed workflows.";

// Providers whose encrypted credentials the hub watches for the shared re-entry
// aggregate (#2079). C4/C5/C6 add "stripe" / "google" / "backup" here.
const HUB_PROVIDERS = ["xero"] as const;

export default async function IntegrationsHubPage() {
  const features = await loadEffectiveModuleFlags();

  // Unified "N integrations need credentials re-entered (encryption key
  // changed)" surface, driven by the same GCM-failure detection readiness uses.
  // Fail-open: a DB error must never break the hub, so show no banner.
  let reentryCount = 0;
  try {
    reentryCount = (await getIntegrationsNeedingReentry(HUB_PROVIDERS)).length;
  } catch {
    reentryCount = 0;
  }

  const description =
    reentryCount > 0
      ? `${reentryCount} integration${reentryCount === 1 ? "" : "s"} need credentials re-entered (the app encryption key changed). ${BASE_DESCRIPTION}`
      : BASE_DESCRIPTION;

  return (
    <AdminHubPage
      title="Integrations"
      description={description}
      sections={sections}
      features={features}
    />
  );
}
