// @vitest-environment jsdom

/**
 * Role-driven admin sidebar panels and the staff top bar (#108).
 */
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AppAccessRole } from "@/lib/access-roles";
import {
  ADMIN_PERMISSION_AREAS,
  getAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ADMIN_NAV_PANELS,
  ADMIN_NAV_PANEL_KEYS,
  ADMIN_NAV_PANEL_STORAGE_KEY,
  getAdminNavPanelChoices,
  pickStoredAdminNavPanel,
  resolveAdminNavPanels,
} from "@/lib/admin-nav-panels";
import { requireCalendarDate } from "@/lib/club-time";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/payments",
}));

import {
  ADMIN_NAV_SECTION_ORDER,
  AdminSidebar,
  getPanelAdminNavSections,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";
import { getNavBarLinks } from "@/components/nav-bar";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

const CLUB_DAY = requireCalendarDate("2026-07-01");

function matrixFor(...roles: AppAccessRole[]): AdminPermissionMatrix {
  return getAdminPermissionMatrix({ canLogin: true, accessRoles: roles });
}

function hrefs(
  panelKey: (typeof ADMIN_NAV_PANEL_KEYS)[number],
  matrix: AdminPermissionMatrix,
  isFullAdmin = false,
) {
  return getPanelAdminNavSections(CLUB_DAY, allOn, panelKey, matrix, isFullAdmin)
    .flatMap((section) => section.items.map((item) => item.href));
}

function labels(
  panelKey: (typeof ADMIN_NAV_PANEL_KEYS)[number],
  matrix: AdminPermissionMatrix,
) {
  return getPanelAdminNavSections(CLUB_DAY, allOn, panelKey, matrix).flatMap(
    (section) => section.items.map((item) => item.label),
  );
}

/** Every single-area grid at view and at edit, plus the seeded bundles. */
const GRIDS: Array<[string, AdminPermissionMatrix]> = [
  ...ADMIN_PERMISSION_AREAS.flatMap((area) =>
    (["view", "edit"] as const).map((level): [string, AdminPermissionMatrix] => [
      `${area.key}:${level}`,
      {
        ...Object.fromEntries(
          ADMIN_PERMISSION_AREAS.map((other) => [other.key, "none"]),
        ),
        [area.key]: level,
      } as AdminPermissionMatrix,
    ]),
  ),
  ...(
    [
      "ADMIN_READONLY",
      "ADMIN_BOOKINGS",
      "ADMIN_MEMBERSHIP",
      "ADMIN_CONTENT",
      "FINANCE_ADMIN",
      "FINANCE_USER",
    ] as const
  ).map((role): [string, AdminPermissionMatrix] => [role, matrixFor(role)]),
];

describe("which panels a person is offered (#108)", () => {
  it.each([
    ["ADMIN", ["admin"]],
    ["ADMIN_READONLY", ["admin"]],
    ["ADMIN_BOOKINGS", ["bookings"]],
    ["ADMIN_MEMBERSHIP", ["admin"]],
    ["ADMIN_CONTENT", ["admin"]],
    ["FINANCE_ADMIN", ["finance"]],
    ["FINANCE_USER", ["finance"]],
  ] as const)("%s → %j", (role, expected) => {
    expect(
      resolveAdminNavPanels(matrixFor(role), role === "ADMIN"),
    ).toEqual(expected);
  });

  it("offers both panels to a Treasurer who is also a Booking Officer", () => {
    expect(
      resolveAdminNavPanels(matrixFor("FINANCE_ADMIN", "ADMIN_BOOKINGS"), false),
    ).toEqual(["finance", "bookings"]);
  });

  it("adds the full menu for an edit area no dedicated panel serves", () => {
    expect(
      resolveAdminNavPanels(matrixFor("ADMIN_BOOKINGS", "ADMIN_MEMBERSHIP"), false),
    ).toEqual(["bookings", "admin"]);
  });

  it("reads a club-made role from its matrix, not its name", () => {
    const custom = {
      ...matrixFor(),
      overview: "view",
      lodge: "edit",
    } as AdminPermissionMatrix;
    expect(resolveAdminNavPanels(custom, false)).toEqual(["bookings"]);
  });

  it("keeps the historical full menu when no matrix is supplied", () => {
    expect(resolveAdminNavPanels(undefined, false)).toEqual(["admin"]);
  });

  it("always keeps the full admin menu one press away", () => {
    expect(getAdminNavPanelChoices(["finance"])).toEqual(["finance", "admin"]);
    expect(getAdminNavPanelChoices(["admin"])).toEqual(["admin"]);
  });

  it("ignores a remembered panel the person no longer has", () => {
    expect(pickStoredAdminNavPanel("bookings", ["finance", "admin"])).toBe(
      "finance",
    );
    expect(pickStoredAdminNavPanel("admin", ["finance", "admin"])).toBe("admin");
    expect(pickStoredAdminNavPanel(null, ["bookings", "admin"])).toBe("bookings");
  });
});

describe("panel contents (#108)", () => {
  it("names only catalogue sections and catalogue pages", () => {
    const catalogueHrefs = new Set(
      getVisibleAdminNavSections(CLUB_DAY, allOn).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    );
    for (const key of ADMIN_NAV_PANEL_KEYS) {
      const panel = ADMIN_NAV_PANELS[key];
      if (panel.sections !== "all") {
        for (const label of panel.sections) {
          expect(ADMIN_NAV_SECTION_ORDER).toContain(label);
        }
      }
      for (const entry of panel.borrowed) {
        expect(catalogueHrefs).toContain(entry.href);
        expect(ADMIN_NAV_SECTION_ORDER).toContain(entry.into);
      }
    }
  });

  it.each(GRIDS)(
    "never shows a %s grid a page its full menu hides",
    (_name, matrix) => {
      const full = new Set(hrefs("admin", matrix));
      for (const key of ADMIN_NAV_PANEL_KEYS) {
        for (const href of hrefs(key, matrix)) {
          // The /finance workspace link is the one non-catalogue entry; it is
          // shown only to finance-area holders, the workspace's own rule.
          if (href === "/finance") {
            expect(matrix.finance).not.toBe("none");
            continue;
          }
          expect(full).toContain(href);
        }
      }
    },
  );

  it("leaves the Admin panel exactly as the full menu", () => {
    const matrix = matrixFor("ADMIN");
    expect(getPanelAdminNavSections(CLUB_DAY, allOn, "admin", matrix, true)).toEqual(
      getVisibleAdminNavSections(CLUB_DAY, allOn, matrix, true),
    );
  });

  it("gives a Treasurer the finance pages, wherever the catalogue files them", () => {
    const shown = labels("finance", matrixFor("FINANCE_ADMIN"));
    expect(shown).toEqual(
      expect.arrayContaining([
        "Finance Dashboard",
        "Fees",
        "Payments",
        "Internet Banking",
        "Refunds & Credits",
        "Reports",
        "Xero Sync",
        "Xero Member Grouping",
        "Subscriptions",
        "Integrations",
      ]),
    );
    expect(shown).not.toContain("Members");
    expect(shown).not.toContain("Booking Policies");
    expect(shown).not.toContain("System Health");
  });

  it("gives a Booking Officer bookings, rates, finance and lodge operations", () => {
    const shown = labels("bookings", matrixFor("ADMIN_BOOKINGS"));
    expect(shown).toEqual(
      expect.arrayContaining([
        "Bookings",
        "Book on Behalf",
        "Bed Allocation",
        "Bookings Setup",
        "Promo Codes",
        "Booking Policies",
        "Fees",
        "Payments",
        "Roster",
        "Calendar",
      ]),
    );
    expect(shown).not.toContain("Members");
    expect(shown).not.toContain("System Health");
    expect(shown).not.toContain("Finance Dashboard");
  });
});

describe("AdminSidebar panels (#108)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
  });

  it("opens a Treasurer on the Finance panel and switches to the full menu", () => {
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("FINANCE_ADMIN")}
        isFullAdmin={false}
      />,
    );

    expect(screen.getAllByText("Finance Panel").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Subscriptions" }).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Full admin" })[0]);

    expect(screen.getAllByText("Admin Panel").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Members" }).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(ADMIN_NAV_PANEL_STORAGE_KEY)).toBe("admin");
  });

  it("restores a remembered panel after mount", () => {
    window.localStorage.setItem(ADMIN_NAV_PANEL_STORAGE_KEY, "admin");
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("FINANCE_ADMIN")}
        isFullAdmin={false}
      />,
    );
    expect(screen.getAllByText("Admin Panel").length).toBeGreaterThan(0);
  });

  it("shows a Full Admin the Admin Panel with no switcher", () => {
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("ADMIN")}
        isFullAdmin
      />,
    );
    expect(screen.getAllByText("Admin Panel").length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "Admin menu" })).toBeNull();
  });
});

describe("staff top bar (#108)", () => {
  const user = {
    name: "Pat Admin",
    email: "pat@example.org",
    role: "ADMIN",
    canAccessAdmin: true,
    canAccessFinance: true,
  };

  it("drops the member-journey links on the staff shells", () => {
    const shown = getNavBarLinks(user, allOn, "Hut Leader", "staff").map(
      (link) => link.label,
    );
    expect(shown).not.toContain("Book");
    expect(shown).not.toContain("My Bookings");
    expect(shown).not.toContain("Who's at the lodge");
    expect(shown).toEqual(
      expect.arrayContaining(["Home", "Dashboard", "Profile", "Finance", "Admin"]),
    );
  });

  it("keeps them on the member shell", () => {
    const shown = getNavBarLinks(user, allOn).map((link) => link.label);
    expect(shown).toEqual(
      expect.arrayContaining(["Book", "My Bookings", "Who's at the lodge"]),
    );
  });
});
