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
  canViewAdminHrefWithMatrix,
  getAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ADMIN_NAV_PANELS,
  ADMIN_NAV_PANEL_KEYS,
  ADMIN_NAV_PANEL_STORAGE_KEY,
  NEEDS_ATTENTION_LABEL,
  pickStoredAdminNavPanel,
  resolveAdminNavPanels,
  resolveMemberAdminNavPanels,
} from "@/lib/admin-nav-panels";
import { ADMIN_APPEARANCE_PAGES } from "@/lib/admin-appearance-pages";
import { requireCalendarDate } from "@/lib/club-time";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/payments",
}));

import {
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

/** The panels for roles held together, each judged by its own matrix. */
function panelsFor(...roles: AppAccessRole[]) {
  return resolveMemberAdminNavPanels({ canLogin: true, accessRoles: roles });
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
    ["ADMIN_MEMBERSHIP", ["membership"]],
    ["ADMIN_CONTENT", ["content"]],
    ["FINANCE_USER", ["finance"]],
    ["FINANCE_ADMIN", ["treasurer"]],
  ] as const)("%s \u2192 %j", (role, expected) => {
    expect(panelsFor(role)).toEqual(expected);
  });

  it("offers one menu per role held, in switcher order", () => {
    expect(panelsFor("FINANCE_ADMIN", "ADMIN_BOOKINGS")).toEqual([
      "bookings",
      "treasurer",
    ]);
    expect(panelsFor("ADMIN_BOOKINGS", "ADMIN_MEMBERSHIP")).toEqual([
      "bookings",
      "membership",
    ]);
  });

  it("gives a Full Admin only Admin, plus any other role they hold", () => {
    expect(panelsFor("ADMIN")).toEqual(["admin"]);
    expect(panelsFor("ADMIN", "FINANCE_ADMIN")).toEqual(["admin", "treasurer"]);
  });

  it("does not offer Admin to someone who holds no admin role", () => {
    for (const role of [
      "ADMIN_BOOKINGS",
      "ADMIN_MEMBERSHIP",
      "ADMIN_CONTENT",
      "FINANCE_USER",
      "FINANCE_ADMIN",
    ] as const) {
      expect(panelsFor(role)).not.toContain("admin");
    }
  });

  it("reads a club-made role from its matrix, not its name", () => {
    const custom = {
      ...matrixFor(),
      overview: "view",
      lodge: "edit",
    } as AdminPermissionMatrix;
    expect(resolveAdminNavPanels([custom])).toEqual(["bookings"]);
  });

  it("gives a role that only edits support the full menu it needs", () => {
    const custom = { ...matrixFor(), support: "edit" } as AdminPermissionMatrix;
    expect(resolveAdminNavPanels([custom])).toEqual(["admin"]);
  });

  it("puts a view-only role on the one panel covering it, else the full menu", () => {
    const none = matrixFor();
    const auditor = {
      ...none,
      overview: "view",
      bookings: "view",
      finance: "view",
    } as AdminPermissionMatrix;
    const lodgeViewer = { ...none, lodge: "view" } as AdminPermissionMatrix;
    const financeOnly = {
      ...none,
      overview: "view",
      finance: "view",
    } as AdminPermissionMatrix;
    const overviewOnly = { ...none, overview: "view" } as AdminPermissionMatrix;
    expect(resolveAdminNavPanels([auditor])).toEqual(["admin"]);
    expect(resolveAdminNavPanels([lodgeViewer])).toEqual(["bookings"]);
    expect(resolveAdminNavPanels([financeOnly])).toEqual(["finance"]);
    expect(resolveAdminNavPanels([overviewOnly])).toEqual(["admin"]);
  });

  it("ignores a role with no admin area beside a role that has one", () => {
    expect(resolveAdminNavPanels([matrixFor(), matrixFor("FINANCE_USER")])).toEqual(
      ["finance"],
    );
  });

  it("falls back to the full menu when no role yields a panel", () => {
    expect(resolveAdminNavPanels([])).toEqual(["admin"]);
    expect(resolveAdminNavPanels([matrixFor()])).toEqual(["admin"]);
  });

  it("ignores a remembered panel the person no longer has", () => {
    expect(pickStoredAdminNavPanel("admin", ["treasurer"])).toBe("treasurer");
    expect(pickStoredAdminNavPanel("finance", ["bookings", "finance"])).toBe(
      "finance",
    );
    expect(pickStoredAdminNavPanel(null, ["bookings", "treasurer"])).toBe(
      "bookings",
    );
  });
});

describe("panel contents (#108)", () => {
  it("names only catalogue sections and catalogue pages", () => {
    const catalogue = getVisibleAdminNavSections(CLUB_DAY, allOn);
    const catalogueLabels = catalogue.map((section) => section.label);
    const catalogueHrefs = new Set(
      catalogue.flatMap((section) => section.items.map((item) => item.href)),
    );
    for (const key of ADMIN_NAV_PANEL_KEYS) {
      const panel = ADMIN_NAV_PANELS[key];
      if (panel.sections !== "all") {
        for (const label of panel.sections) {
          expect(catalogueLabels).toContain(label);
        }
      }
      for (const entry of panel.borrowed) {
        expect(catalogueHrefs).toContain(entry.href);
        expect(catalogueLabels).toContain(entry.into);
      }
    }
  });

  it("names only queues the Needs Attention section actually has", () => {
    // A queue whose href moves must not silently drop out of a panel.
    const queuePaths = new Set(
      getVisibleAdminNavSections(CLUB_DAY, allOn)
        .filter((section) => section.label === NEEDS_ATTENTION_LABEL)
        .flatMap((section) =>
          section.items.map((item) => item.href.split(/[?#]/)[0]),
        ),
    );
    for (const key of ADMIN_NAV_PANEL_KEYS) {
      const paths = ADMIN_NAV_PANELS[key].attentionPaths;
      if (paths === "all") continue;
      for (const path of paths) expect(queuePaths).toContain(path);
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
          // The Content panel lists the hub's pages, which the full menu reaches
          // through the one hub link: each is held to the page's own rule.
          if (ADMIN_APPEARANCE_PAGES.some((page) => page.href === href)) {
            expect(canViewAdminHrefWithMatrix(matrix, href)).toBe(true);
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
    const shown = labels("treasurer", matrixFor("FINANCE_ADMIN"));
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

  it("gives the Finance menu less than the Treasurer's", () => {
    const matrix = matrixFor("FINANCE_ADMIN");
    const finance = labels("finance", matrix);
    expect(finance).toEqual(
      expect.arrayContaining(["Finance Dashboard", "Payments", "Reports"]),
    );
    expect(finance).not.toContain("Subscriptions");
    expect(finance).not.toContain("Integrations");
    for (const label of finance) {
      expect(labels("treasurer", matrix)).toContain(label);
    }
  });

  it("gives a Membership Officer the member pages and their queues", () => {
    const shown = labels("membership", matrixFor("ADMIN_MEMBERSHIP"));
    expect(shown).toEqual(
      expect.arrayContaining([
        "Members",
        "Applications",
        "Family Groups",
        "Communications",
        "Membership & Members",
      ]),
    );
    expect(shown).not.toContain("Bookings");
    expect(shown).not.toContain("Payments");
  });

  it("lists the appearance hub's pages for a Content Manager", () => {
    const shown = labels("content", matrixFor("ADMIN_CONTENT"));
    expect(shown).toEqual(
      expect.arrayContaining(["Site Style", "Page Content", "Image Manager"]),
    );
    expect(shown).not.toContain("Members");
    expect(shown).not.toContain("Payments");
  });

  it("keeps the Content panel to the pages a role and the modules allow", () => {
    const pages = ADMIN_APPEARANCE_PAGES.map((page) => page.href);
    const viewOnly = hrefs("content", { ...matrixFor() } as AdminPermissionMatrix);
    for (const href of pages) expect(viewOnly).not.toContain(href);

    const moduleOff = getPanelAdminNavSections(
      CLUB_DAY,
      { ...allOn, skifieldConditions: false } as FeatureFlags,
      "content",
      matrixFor("ADMIN_CONTENT"),
    ).flatMap((section) => section.items.map((item) => item.label));
    expect(labels("content", matrixFor("ADMIN_CONTENT"))).toContain(
      "Mountain Conditions",
    );
    expect(moduleOff).not.toContain("Mountain Conditions");
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

  it("offers only the menus passed in, and switches between them", () => {
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("FINANCE_ADMIN", "ADMIN_BOOKINGS")}
        isFullAdmin={false}
        panels={["bookings", "treasurer"]}
      />,
    );

    expect(screen.getAllByText("Bookings Panel").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Subscriptions" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Treasurer" })[0]);

    expect(screen.getAllByText("Treasurer Panel").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: "Subscriptions" }).length,
    ).toBeGreaterThan(0);
    expect(window.localStorage.getItem(ADMIN_NAV_PANEL_STORAGE_KEY)).toBe(
      "treasurer",
    );
  });

  it("restores a remembered panel after mount", () => {
    window.localStorage.setItem(ADMIN_NAV_PANEL_STORAGE_KEY, "treasurer");
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("FINANCE_ADMIN", "ADMIN_BOOKINGS")}
        isFullAdmin={false}
        panels={["bookings", "treasurer"]}
      />,
    );
    expect(screen.getAllByText("Treasurer Panel").length).toBeGreaterThan(0);
  });

  it("shows one role its menu with no switcher", () => {
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("FINANCE_ADMIN")}
        isFullAdmin={false}
        panels={["treasurer"]}
      />,
    );
    expect(screen.getAllByText("Treasurer Panel").length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "Admin menu" })).toBeNull();
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

  it("leaves the dashboard links to the top bar, on every menu", () => {
    render(
      <AdminSidebar
        features={allOn}
        permissionMatrix={matrixFor("ADMIN")}
        isFullAdmin
      />,
    );
    expect(screen.queryByRole("link", { name: "Member Dashboard" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Admin Dashboard" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Payments" }).length).toBeGreaterThan(0);
  });

  it("still finds the Admin Dashboard through search", () => {
    expect(
      getVisibleAdminNavSections(CLUB_DAY, allOn, matrixFor("ADMIN"), true).flatMap(
        (section) => section.items.map((item) => item.label),
      ),
    ).toContain("Admin Dashboard");
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
