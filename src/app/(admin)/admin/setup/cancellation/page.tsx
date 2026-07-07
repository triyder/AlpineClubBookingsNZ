import { ClipboardList, Mail, UserX } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/membership-cancellation",
    title: "Membership Cancellation",
    description:
      "Configure cancellation warning copy, rejoin-process text, and Xero cancellation handling.",
    icon: UserX,
  },
  {
    href: "/admin/membership-cancellations",
    title: "Cancellation Requests",
    description:
      "Review pending member cancellation requests before changing live cancellation policy.",
    icon: ClipboardList,
  },
  {
    href: "/admin/email-messages",
    title: "Email Messages",
    description:
      "Edit audited email templates used by cancellation and lifecycle workflows.",
    icon: Mail,
  },
];

export default async function CancellationSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Cancellation"
      description="Review the setup pages that govern member cancellation settings, request handling, and related message copy."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
    />
  );
}
