import { BedDouble, MessageSquareText } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const sections: AdminHubSection[] = [
  {
    href: "/admin/rooms-beds",
    title: "Rooms & Beds",
    description:
      "Configure lodge rooms, active beds, and bed-allocation inventory.",
    icon: BedDouble,
  },
  {
    href: "/admin/booking-messages",
    title: "Booking Messages",
    description:
      "Edit member-facing booking, payment, cancellation, and group booking copy.",
    icon: MessageSquareText,
  },
];

export default async function BookingsSetupHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Bookings Setup"
      description="Configure booking-related setup pages that operators revisit less often than daily booking queues."
      sections={sections}
      features={features}
    />
  );
}
