/**
 * Role-driven admin sidebar PANELS (#108).
 *
 * A panel is a VIEW over the one admin nav catalogue (`buildAdminNavSections`
 * in `src/components/admin-sidebar.tsx`), never a second copy of it
 * (`INV-SSOT`): it names whole catalogue sections, a few pages borrowed from
 * other sections, and which "Needs Attention" queues it keeps. A page added to
 * a section therefore appears in every panel that shows that section.
 *
 * A panel only ever NARROWS. It is applied to sections the sidebar has already
 * filtered item by item (module flags, `fullAdminOnly`, `orAccess`, the
 * permission matrix), and a borrowed page is looked up in those same filtered
 * sections — so no panel can show a link the full sidebar would hide. Opening a
 * page is still decided by `guardAdminLayout` and `requireAdmin`; nothing here
 * is authorization.
 *
 * Which panels a person is offered comes from their permission MATRIX, never
 * from a role's name (`INV-CONFIG-001`): roles are club-editable and clubs
 * create their own, so "Treasurer" is not a stable input but `finance: edit`
 * is.
 */
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionArea,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/**
 * Label of the queue-driven sidebar section whose items are shown only while
 * their queue has something pending. Lives here because the panel projection
 * and the sidebar both have to recognise it.
 */
export const NEEDS_ATTENTION_LABEL = "Needs Attention";

/** localStorage key holding the panel the viewer last picked in the switcher. */
export const ADMIN_NAV_PANEL_STORAGE_KEY = "admin-sidebar:panel";

export const ADMIN_NAV_PANEL_KEYS = ["finance", "bookings", "admin"] as const;
export type AdminNavPanelKey = (typeof ADMIN_NAV_PANEL_KEYS)[number];

export interface AdminNavPanelDefinition {
  key: AdminNavPanelKey;
  /** Sidebar heading while this panel is shown. */
  title: string;
  /** Button text in the panel switcher. */
  switcherLabel: string;
  /**
   * Permission areas whose holders are offered this panel. Empty for the Admin
   * panel, which is offered by the rule in {@link resolveAdminNavPanels}.
   */
  areas: readonly AdminPermissionArea[];
  /** Catalogue sections shown whole, by label; `"all"` for the full menu. */
  sections: readonly string[] | "all";
  /** Pages borrowed from other catalogue sections, appended to `into`. */
  borrowed: ReadonlyArray<{ href: string; into: string }>;
  /**
   * The "Needs Attention" queues this panel keeps, by pathname (a queue's
   * query string is ignored, so both unpaid-stay deep links match
   * `/admin/bookings`).
   */
  attentionPaths: readonly string[] | "all";
}

export const ADMIN_NAV_PANELS: Readonly<
  Record<AdminNavPanelKey, AdminNavPanelDefinition>
> = {
  finance: {
    key: "finance",
    title: "Finance Panel",
    switcherLabel: "Finance",
    areas: ["finance"],
    sections: ["Finance"],
    borrowed: [
      { href: "/admin/subscriptions", into: "Finance" },
      { href: "/admin/integrations", into: "Finance" },
    ],
    attentionPaths: ["/admin/refund-requests", "/admin/bookings"],
  },
  bookings: {
    key: "bookings",
    title: "Bookings Panel",
    switcherLabel: "Bookings",
    // Lodge Operations rides with bookings: the seeded Booking Officer holds
    // `lodge: edit` (issue #108, decided 2026-11-05).
    areas: ["bookings", "lodge"],
    sections: [
      "Bookings & Beds",
      "Rates & Policies",
      "Finance",
      "Lodge Operations",
    ],
    borrowed: [{ href: "/admin/bookings-setup", into: "Bookings & Beds" }],
    attentionPaths: [
      "/admin/booking-requests",
      "/admin/bookings",
      "/admin/hut-leaders",
    ],
  },
  admin: {
    key: "admin",
    title: "Admin Panel",
    switcherLabel: "Full admin",
    areas: [],
    sections: "all",
    borrowed: [],
    attentionPaths: "all",
  },
};

/**
 * `overview` is the dashboard and cross-area entry points; every seeded admin
 * role holds it, so it never decides which panel someone works in.
 */
const PANEL_NEUTRAL_AREAS: readonly AdminPermissionArea[] = ["overview"];

const DEDICATED_PANELS = ADMIN_NAV_PANEL_KEYS.filter(
  (key) => ADMIN_NAV_PANELS[key].areas.length > 0,
);

/**
 * The panels this person works in, default first. The Admin panel is always
 * reachable through the switcher whether or not it is listed here — see
 * {@link getAdminNavPanelChoices}.
 *
 * - Full Admin (or no matrix at all, the sidebar's historical fail-open
 *   contract) → the Admin panel, unchanged.
 * - Otherwise the areas the person can EDIT decide; someone who edits nothing
 *   is placed by the areas they can VIEW.
 * - Each dedicated panel serving one of those areas is offered, in
 *   {@link ADMIN_NAV_PANEL_KEYS} order.
 * - An area no dedicated panel serves (membership, content, support) adds the
 *   Admin panel, because only the full menu shows it. A view-only person with
 *   such an area (Read-only Admin) gets the Admin panel alone: they browse
 *   everything and work in nothing, so the full menu is their panel.
 */
export function resolveAdminNavPanels(
  permissionMatrix: AdminPermissionMatrix | undefined,
  isFullAdmin: boolean | undefined,
): AdminNavPanelKey[] {
  if (isFullAdmin || !permissionMatrix) return ["admin"];

  const areas = ADMIN_PERMISSION_AREAS.map((area) => area.key);
  const editAreas = areas.filter((area) => permissionMatrix[area] === "edit");
  const basis =
    editAreas.length > 0
      ? editAreas
      : areas.filter((area) => permissionMatrix[area] !== "none");

  const dedicated = DEDICATED_PANELS.filter((key) =>
    ADMIN_NAV_PANELS[key].areas.some((area) => basis.includes(area)),
  );
  const uncovered = basis.filter(
    (area) =>
      !PANEL_NEUTRAL_AREAS.includes(area) &&
      !DEDICATED_PANELS.some((key) => ADMIN_NAV_PANELS[key].areas.includes(area)),
  );

  if (uncovered.length > 0 && editAreas.length === 0) return ["admin"];
  const panels: AdminNavPanelKey[] = [...dedicated];
  if (uncovered.length > 0 || panels.length === 0) panels.push("admin");
  return panels;
}

/**
 * The switcher's buttons: the person's panels plus the Admin panel ("Full
 * admin"), which every panel keeps one press away so no page the person may
 * open is ever missing from the menu. A single entry means no switcher.
 */
export function getAdminNavPanelChoices(
  panels: readonly AdminNavPanelKey[],
): AdminNavPanelKey[] {
  return panels.includes("admin") ? [...panels] : [...panels, "admin"];
}

/** A stored switcher choice, accepted only if it is still one of `choices`. */
export function pickStoredAdminNavPanel(
  stored: string | null,
  choices: readonly AdminNavPanelKey[],
): AdminNavPanelKey {
  return choices.find((key) => key === stored) ?? choices[0] ?? "admin";
}

function pathnameOf(href: string) {
  return href.split(/[?#]/)[0] ?? href;
}

/**
 * Project already-filtered sidebar sections onto one panel.
 *
 * `leadingItems` are panel-only links that are not admin catalogue pages (the
 * Finance panel's link to the `/finance` workspace), keyed by the section they
 * open; the caller filters them, as it filters everything else.
 */
export function projectAdminNavPanel<
  I extends { href: string },
  S extends { label?: string; items: I[] },
>(
  sections: readonly S[],
  panelKey: AdminNavPanelKey,
  leadingItems: Readonly<Record<string, readonly I[]>> = {},
): S[] {
  const panel = ADMIN_NAV_PANELS[panelKey];
  if (panel.sections === "all") return [...sections];
  const shown = panel.sections;

  const byHref = new Map<string, I>();
  for (const section of sections) {
    if (section.label === NEEDS_ATTENTION_LABEL) continue;
    for (const item of section.items) {
      if (!byHref.has(item.href)) byHref.set(item.href, item);
    }
  }

  return sections
    .filter(
      (section) =>
        section.label === undefined ||
        section.label === NEEDS_ATTENTION_LABEL ||
        shown.includes(section.label),
    )
    .map((section) => {
      if (section.label === NEEDS_ATTENTION_LABEL) {
        const keep = panel.attentionPaths;
        return {
          ...section,
          items: section.items.filter(
            (item) => keep === "all" || keep.includes(pathnameOf(item.href)),
          ),
        };
      }
      if (section.label === undefined) return section;
      const label = section.label;
      const own = new Set(section.items.map((item) => item.href));
      const borrowed = panel.borrowed
        .filter((entry) => entry.into === label && !own.has(entry.href))
        .map((entry) => byHref.get(entry.href))
        .filter((item): item is I => item !== undefined);
      return {
        ...section,
        items: [...(leadingItems[label] ?? []), ...section.items, ...borrowed],
      };
    })
    .filter((section) => section.items.length > 0);
}
