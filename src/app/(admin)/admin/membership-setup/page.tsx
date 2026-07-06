import { BadgeCheck, Lock, Sliders } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const sections: AdminHubSection[] = [
  {
    href: "/admin/membership-types",
    title: "Membership Types",
    description:
      "Configure seasonal membership categories, booking policy, and subscription rules.",
    icon: BadgeCheck,
  },
  {
    href: "/admin/member-fields",
    title: "Member Fields",
    description:
      "Choose the extra profile fields collected from members and applicants.",
    icon: Sliders,
  },
  {
    href: "/admin/subscription-lockout",
    title: "Subscription Lockout",
    description:
      "Control when unpaid subscriptions block member booking and access actions.",
    icon: Lock,
  },
];

export default async function MembershipSetupHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Membership & Members"
      description="Configure membership categories, member profile fields, and subscription enforcement."
      sections={sections}
      features={features}
    />
  );
}
