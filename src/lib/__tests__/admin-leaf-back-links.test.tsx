// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// #1940: several leaf pages now read the session permission matrix for view-only
// gating; provide an edit-level admin session so the back-link render succeeds.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

// The leaf pages embed heavy client panels/sections that fetch on mount; the
// back-link lives at the top of each page's render, so stub the panels out and
// assert only that every drill-down leaf points at its current parent hub.
vi.mock("@/components/admin/booking-policies/booking-periods-section", () => ({
  BookingPeriodsSection: () => null,
}));
vi.mock("@/components/admin/site-content-panel", () => ({
  SiteContentPanel: () => null,
}));

import BookingPeriodsPage from "@/app/(admin)/admin/booking-policies/periods/page";
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";
import SiteContentAdminPage from "@/app/(admin)/admin/site-content/page";

describe("admin drill-down leaf back links", () => {
  it("points a Booking Policies leaf back at the Booking Policies hub (replaced inline link)", () => {
    const html = renderToStaticMarkup(<BookingPeriodsPage />);

    expect(html).toContain('href="/admin/booking-policies"');
    expect(html).toContain("← Booking Policies");
  });

  it("points the Membership Types leaf back at the Membership & Members hub (new link — owner finding 7)", () => {
    const html = renderToStaticMarkup(<AdminMembershipTypesPage />);

    expect(html).toContain('href="/admin/membership-setup"');
    expect(html).toContain("← Membership &amp; Members");
  });

  it("points a Site Appearance leaf back at the Site Appearance & Content hub (new link)", () => {
    const html = renderToStaticMarkup(<SiteContentAdminPage />);

    expect(html).toContain('href="/admin/appearance"');
    expect(html).toContain("← Site Appearance &amp; Content");
  });
});
