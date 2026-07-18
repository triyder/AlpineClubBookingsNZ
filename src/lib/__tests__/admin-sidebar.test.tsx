// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPendingCounts } from "@/lib/admin-pending-counts";

const SIDEBAR_COLLAPSE_STORAGE_KEY = "admin-sidebar:expanded-sections";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/dashboard",
}));

import {
  AdminSidebar,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";

const ZERO_COUNTS: AdminPendingCounts = {
  familyRequests: 0,
  memberApplications: 0,
  refundAppeals: 0,
  creditApprovals: 0,
  bookingReviews: 0,
  bookingChangeRequests: 0,
  publicBookingRequests: 0,
  unpaidFinishedStays: 0,
  unsettledAdditionalFinishedStays: 0,
  membershipCancellations: 0,
  archiveRequests: 0,
  deletionRequests: 0,
  memberDeleteRequests: 0,
  issueReports: 0,
  unassignedHutLeaderDates: 0,
};

function buildFetchMock(counts: Partial<AdminPendingCounts> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/api/admin/pending-counts")) {
      return { ok: true, json: async () => ({ ...ZERO_COUNTS, ...counts }) };
    }

    return { ok: true, json: async () => ({}) };
  });
}

describe("AdminSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", buildFetchMock());
  });

  it("expands sections by default and persists collapsed state", () => {
    render(<AdminSidebar features={allOn} />);

    const sectionToggle = screen.getByRole("button", {
      name: "Bookings & Beds",
    });
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Bookings" })).not.toBeNull();

    fireEvent.click(sectionToggle);

    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Bookings" })).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ "Bookings & Beds": false });
  });

  it("restores persisted collapsed sections after mount", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ Finance: false }),
    );

    render(<AdminSidebar features={allOn} />);

    const financeToggle = screen.getByRole("button", { name: "Finance" });
    await waitFor(() =>
      expect(financeToggle.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
  });

  it("fetches all badge counts with a single request", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/admin/pending-counts",
    );
  });

  it("groups setup and configuration around the setup hubs", () => {
    const section = getVisibleAdminNavSections(allOn, undefined, true).find(
      (item) => item.label === "Setup & Configuration",
    );

    expect(section?.items.map((item) => item.label)).toEqual([
      "Setup",
      "Modules",
      // Login & Security page (#2033): sits with the other system-config
      // surfaces in Setup & Configuration.
      "Login & Security",
      "Lodges",
      "Membership & Members",
      "Site Appearance & Content",
      "Bookings Setup",
      "Integrations",
      "Notifications & Email",
      "Access Roles",
      "Export & Import",
      "Committee",
    ]);
  });

  it("retires lodge-scoped Chores/Lockers/Seasons from the sidebar — reached via the lodge hub (#130)", () => {
    const sections = getVisibleAdminNavSections(allOn);
    const allLabels = sections.flatMap((section) =>
      section.items.map((item) => item.label),
    );
    // Multi-lodge core (ADR-005): these are lodge-scoped editors, reached as
    // Configure cards under /admin/lodges/[id], not standalone sidebar entries.
    expect(allLabels).not.toContain("Chores");
    expect(allLabels).not.toContain("Lockers");
    expect(allLabels).not.toContain("Hut Fees & Seasons");
    // The single Lodges entry remains the way in.
    expect(allLabels).toContain("Lodges");
    // Unrelated retirement still holds.
    expect(allLabels).not.toContain("Booking Messages");
  });

  it("shows the consolidated Fees link on bookings OR finance view, hides it for neither (#1933, E7)", () => {
    const matrix = (over: Partial<Record<string, "none" | "view" | "edit">>) => ({
      overview: "none", bookings: "none", membership: "none", finance: "none",
      lodge: "none", content: "none", support: "none", ...over,
    }) as Parameters<typeof getVisibleAdminNavSections>[1];
    const feesVisible = (m: Parameters<typeof getVisibleAdminNavSections>[1]) =>
      getVisibleAdminNavSections(allOn, m)
        .flatMap((section) => section.items.map((item) => item.href))
        .includes("/admin/fees");

    expect(feesVisible(matrix({ bookings: "view" }))).toBe(true);
    expect(feesVisible(matrix({ finance: "view" }))).toBe(true);
    expect(feesVisible(matrix({ bookings: "edit" }))).toBe(true);
    expect(feesVisible(matrix({ finance: "edit" }))).toBe(true);
    // Neither bookings nor finance → no Fees link, and the old fee-configuration
    // link is gone entirely.
    expect(feesVisible(matrix({ membership: "edit" }))).toBe(false);
    const membershipOnly = getVisibleAdminNavSections(allOn, matrix({ membership: "edit" }))
      .flatMap((section) => section.items.map((item) => item.href));
    expect(membershipOnly).not.toContain("/admin/fee-configuration");
  });

  it("keeps pending family group requests visible while Members is collapsed", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ Members: false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ familyRequests: 2 }));

    render(<AdminSidebar features={allOn} />);

    const membersToggle = screen.getByRole("button", { name: "Members" });
    await waitFor(() =>
      expect(membersToggle.getAttribute("aria-expanded")).toBe("false"),
    );

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Family Groups/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("surfaces queued public booking requests in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Bookings & Beds": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ publicBookingRequests: 3 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Booking Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
  });

  it("combines internal review, change request, and public queue counts on the Booking Requests badge", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Bookings & Beds": false }),
    );
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        bookingReviews: 2,
        bookingChangeRequests: 1,
        publicBookingRequests: 3,
      }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Booking Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("6")).not.toBeNull();
  });

  it("surfaces unpaid finished stays in Needs Attention with the dashboard deep link", async () => {
    vi.stubGlobal("fetch", buildFetchMock({ unpaidFinishedStays: 5 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    const link = screen.getByRole("link", { name: /Unpaid Finished Stays/ });
    // Same deep link as the dashboard attention card (#1709/#1731): the
    // bookings list pre-filtered by the shared unpaid-finished-stays helper.
    expect(link.getAttribute("href")).toBe(
      `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=${formatDateOnly(
        getTodayDateOnly(),
      )}`,
    );
    expect(screen.getByText("5")).not.toBeNull();
  });

  it("hides the unpaid finished stays link while nothing is owing", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: /Unpaid Finished Stays/ }),
    ).toBeNull();
  });

  it("surfaces unsettled stay additions in Needs Attention with the dashboard deep link (#1723)", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({ unsettledAdditionalFinishedStays: 4 }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    const link = screen.getByRole("link", { name: /Unpaid Stay Additions/ });
    // Same deep link as the "Finished Stays With Unpaid Additions" dashboard
    // card: the bookings list pre-filtered by the shared additionalOwed
    // helper in unpaid-finished-stays.ts.
    expect(link.getAttribute("href")).toBe(
      `/admin/bookings?additionalOwed=owed&checkOutTo=${formatDateOnly(
        getTodayDateOnly(),
      )}`,
    );
    expect(screen.getByText("4")).not.toBeNull();
  });

  it("hides the unpaid stay additions link while nothing is owing", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: /Unpaid Stay Additions/ }),
    ).toBeNull();
  });

  it("shows unassigned hut leader dates in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Lodge Operations": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ unassignedHutLeaderDates: 4 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(screen.getByRole("link", { name: /Hut Leaders/ })).not.toBeNull();
    expect(screen.getByText("4")).not.toBeNull();
  });

  it("surfaces pending account deletion requests in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Monitoring & Support": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ deletionRequests: 2 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Deletion Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("merges self-service and admin-initiated deletion counts on the Deletion Requests badge (#1938)", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Monitoring & Support": false }),
    );
    // Self-service PENDING (3) + admin-initiated DELETE REQUESTED (2) = 5.
    vi.stubGlobal(
      "fetch",
      buildFetchMock({ deletionRequests: 3, memberDeleteRequests: 2 }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Deletion Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("5")).not.toBeNull();
  });

  it("labels the membership cancellation queue as Cancellation Requests", () => {
    const section = getVisibleAdminNavSections(allOn).find(
      (item) => item.label === "Members",
    );

    expect(section?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/admin/membership-cancellations",
          label: "Cancellation Requests",
        }),
      ]),
    );
  });
});
