import { Bot, CreditCard, DatabaseBackup, KeyRound, Plug } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getIntegrationsNeedingReentry } from "@/lib/integration-credentials";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure the accounting settings used by finance workflows.",
    icon: Plug,
  },
  {
    href: "/admin/stripe/setup",
    title: "Stripe Setup",
    description:
      "Enter your Stripe keys, confirm the account, and connect the payment webhook.",
    icon: CreditCard,
  },
  {
    href: "/admin/google/setup",
    title: "Google sign-in Setup",
    description:
      "Enter your Google OAuth credentials and verify a real sign-in round-trip — no environment variables.",
    icon: KeyRound,
  },
  {
    href: "/admin/backups",
    title: "Database Backups",
    description:
      "Configure the S3 backup destination and credentials, check backup status, and run a backup on demand.",
    icon: DatabaseBackup,
  },
  {
    href: "/admin/ai-assistant",
    title: "AI help assistant",
    description:
      "Enter your Anthropic API key, set a monthly spend cap, and review AI usage. Hidden until the AI assistant module is enabled.",
    icon: Bot,
  },
];

const BASE_DESCRIPTION =
  "Configure connected services used by accounting and other provider-backed workflows.";

// Providers whose encrypted credentials the hub watches for the shared re-entry
// aggregate (#2079). C4/C5/C6 add "stripe" / "google" / "backup" here.
const HUB_PROVIDERS = ["xero", "stripe", "google", "backup", "anthropic"] as const;

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

  // Permission-gate the cards so an admin without support:view does not see the
  // support-area Backups card and dead-end at a redirect (#2095 MINOR-5).
  const permissionMatrix = await loadAdminSetupPermissionMatrix();

  return (
    <AdminHubPage
      title="Integrations"
      description={description}
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
    />
  );
}
