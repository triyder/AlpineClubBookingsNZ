import {
  BadgeInfo,
  FilePenLine,
  Images,
  Megaphone,
  Mountain,
  Palette,
  PanelBottom,
  type LucideIcon,
} from "lucide-react";
import type { AdminHubSection } from "@/components/admin-hub-page";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import { adminHref, getAdminPage } from "@/lib/admin-hubs";
import {
  canOpenAdminPathWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

type AppearancePageId =
  | "club-identity"
  | "site-style"
  | "site-content"
  | "page-content"
  | "site-banners"
  | "mountain-conditions"
  | "image-manager";

/**
 * The hub's own card copy, in card order. Each page's link and title come from
 * the admin hub registry (`WEBSITE_HUB`), so a renamed or moved page follows.
 */
const APPEARANCE_CARDS: ReadonlyArray<{
  id: AppearancePageId;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: "club-identity",
    description:
      "Set the club name, short name, hut-leader label, and your lodge's public details.",
    icon: BadgeInfo,
  },
  {
    id: "site-style",
    description:
      "Set the public theme, logo, colours, fonts, and first-run style completion.",
    icon: Palette,
  },
  {
    id: "site-content",
    description:
      "Edit shared public site chrome such as footer columns and reusable site text.",
    icon: PanelBottom,
  },
  {
    id: "page-content",
    description:
      "Manage public website pages, menus, rich text, tokens, and publishing state.",
    icon: FilePenLine,
  },
  {
    id: "site-banners",
    description:
      "Publish dated notice banners for public visitors and signed-in members.",
    icon: Megaphone,
  },
  {
    id: "mountain-conditions",
    description:
      "Configure Snow.nz condition widgets and public mountain condition content.",
    icon: Mountain,
  },
  {
    id: "image-manager",
    description:
      "Upload and organise filesystem images used by public content editors.",
    icon: Images,
  },
];

/**
 * The Site Appearance & Content pages: the hub's cards and the Content sidebar
 * panel (#108) both read this list, so a new page appears in both.
 */
export const ADMIN_APPEARANCE_PAGES: AdminHubSection[] = APPEARANCE_CARDS.map(
  ({ id, description, icon }) => ({
    href: adminHref(id),
    title: getAdminPage(id).label,
    description,
    icon,
  }),
);

/**
 * The Content panel's section: the catalogue reaches these pages through one
 * hub link, so the panel lists them under the rule the hub's cards use
 * (`AdminHubPage`: module flags, then `canOpenAdminPathWithMatrix`).
 */
export function getContentPanelSections(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
) {
  const items = ADMIN_APPEARANCE_PAGES.filter(
    (page) =>
      isFeatureHrefVisible(page.href, features) &&
      (!permissionMatrix ||
        canOpenAdminPathWithMatrix(permissionMatrix, page.href)),
  ).map(({ href, title, icon }) => ({ href, label: title, icon }));
  return items.length > 0 ? [{ label: "Site Content", items }] : [];
}
