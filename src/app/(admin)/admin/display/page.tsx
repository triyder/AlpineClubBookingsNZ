import { BookOpen, LayoutTemplate, Tv } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

// Lobby Display hub (fork issue #109): one sidebar entry opens this landing
// page of cards instead of the old four-item sidebar group. Mirrors the
// "Site Appearance & Content" hub (/admin/appearance) — the Devices management
// page now lives at /admin/display/devices; the other cards keep their routes.
const sections: AdminHubSection[] = [
  {
    href: "/admin/display/devices",
    title: "Devices",
    description:
      "Pair lobby screens per lodge, assign templates, and set each device's refresh interval.",
    icon: Tv,
  },
  {
    href: "/admin/display/builder",
    title: "Visual builder",
    description:
      "Compose a board by picking a shape and dropping modules into zones — no HTML. Writes a valid layout + template for you.",
    icon: LayoutTemplate,
  },
  {
    href: "/admin/display/layouts",
    title: "Layouts (Advanced)",
    description:
      "Advanced mode: author the structural skeleton by hand — named areas, an HTML body, and a default CSS block.",
    icon: LayoutTemplate,
  },
  {
    href: "/admin/display/templates",
    title: "Templates",
    description:
      "Fill a layout's areas with content or embedded modules, then bind the template to a display.",
    icon: LayoutTemplate,
  },
  {
    href: "/admin/display/reference",
    title: "Reference",
    description:
      "The read-only display vocabulary: embeddable modules, area conditions, and CSS tokens.",
    icon: BookOpen,
  },
];

export default async function DisplayHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Lobby Display"
      description="Manage paired lobby screens and author the layouts, templates, and reference that drive them."
      sections={sections}
      features={features}
    />
  );
}
