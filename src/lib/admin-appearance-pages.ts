import {
  BadgeInfo,
  FilePenLine,
  Images,
  Megaphone,
  Mountain,
  Palette,
  PanelBottom,
} from "lucide-react";
import type { AdminHubSection } from "@/components/admin-hub-page";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/**
 * The Site Appearance & Content pages: the hub's cards and the Content sidebar
 * panel (#108) both read this list, so a new page appears in both.
 */
export const ADMIN_APPEARANCE_PAGES: AdminHubSection[] = [
  {
    href: "/admin/appearance/identity",
    title: "Club Identity",
    description:
      "Set the club name, short name, hut-leader label, and your lodge's public details.",
    icon: BadgeInfo,
  },
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

/**
 * The Content panel's section: the catalogue reaches these pages through one
 * hub link, so the panel lists them under the rules the hub's cards use.
 */
export function getContentPanelSections(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
) {
  const items = ADMIN_APPEARANCE_PAGES.filter(
    (page) =>
      isFeatureHrefVisible(page.href, features) &&
      (!permissionMatrix ||
        canViewAdminHrefWithMatrix(permissionMatrix, page.href)),
  ).map(({ href, title, icon }) => ({ href, label: title, icon }));
  return items.length > 0 ? [{ label: "Site Content", items }] : [];
}
