import {
  FilePenLine,
  Images,
  Megaphone,
  Mountain,
  Palette,
  PanelBottom,
} from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const sections: AdminHubSection[] = [
  {
    href: "/admin/site-style",
    title: "Site Style",
    description:
      "Set the public theme, logo, colours, fonts, and first-run style completion.",
    icon: Palette,
  },
  {
    href: "/admin/site-content",
    title: "Site Content",
    description:
      "Edit shared public site chrome such as footer columns and reusable site text.",
    icon: PanelBottom,
  },
  {
    href: "/admin/page-content",
    title: "Page Content",
    description:
      "Manage public website pages, menus, rich text, tokens, and publishing state.",
    icon: FilePenLine,
  },
  {
    href: "/admin/site-banners",
    title: "Site Banners",
    description:
      "Publish dated notice banners for public visitors and signed-in members.",
    icon: Megaphone,
  },
  {
    href: "/admin/mountain-conditions",
    title: "Mountain Conditions",
    description:
      "Configure Snow.nz condition widgets and public mountain condition content.",
    icon: Mountain,
  },
  {
    href: "/admin/image-manager",
    title: "Image Manager",
    description:
      "Upload and organise filesystem images used by public content editors.",
    icon: Images,
  },
];

export default async function AppearanceHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Site Appearance & Content"
      description="Manage the public site's style, editable content, banners, images, and mountain condition widgets."
      sections={sections}
      features={features}
    />
  );
}
