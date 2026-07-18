// @vitest-environment jsdom

import type { ComponentProps } from "react";
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
// The Lodge display settings sub-page (#110) renders a client card that fetches
// on mount; only its top-of-page BackLink matters here, so stub the card.
vi.mock(
  "@/app/(admin)/admin/lodges/[id]/_components/lodge-display-settings-card",
  () => ({ LodgeDisplaySettingsCard: () => null }),
);

import BookingPeriodsPage from "@/app/(admin)/admin/booking-policies/periods/page";
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";
import SiteContentAdminPage from "@/app/(admin)/admin/site-content/page";
// #2046: the five Lobby Display leaves and the converted [id]-aware drill-downs.
import DisplayDevicesPage from "@/app/(admin)/admin/display/devices/page";
import DisplayLayoutsPage from "@/app/(admin)/admin/display/layouts/page";
import DisplayTemplatesPage from "@/app/(admin)/admin/display/templates/page";
import DisplayReferencePage from "@/app/(admin)/admin/display/reference/page";
import DisplayPreviewPage from "@/app/(admin)/admin/display/preview/page";
import LodgeDisplaySettingsPage from "@/app/(admin)/admin/lodges/[id]/display/page";
import { MemberDetailHeader } from "@/app/(admin)/admin/members/[id]/_components/member-detail-header";

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

  // #2046: the five Lobby Display leaves each drilled into from /admin/display
  // (Preview is reached from Templates). Every one must carry the shared BackLink
  // to its STATIC parent hub. Adding a leaf here without a BackLink fails the test.
  it.each([
    ["Devices", DisplayDevicesPage, "/admin/display", "← Lobby Display"],
    ["Layouts", DisplayLayoutsPage, "/admin/display", "← Lobby Display"],
    ["Templates", DisplayTemplatesPage, "/admin/display", "← Lobby Display"],
    ["Reference", DisplayReferencePage, "/admin/display", "← Lobby Display"],
    [
      "Preview",
      DisplayPreviewPage,
      "/admin/display/templates",
      "← Display Templates",
    ],
  ])(
    "points the Lobby Display %s leaf back at its parent hub",
    (_name, Page, href, label) => {
      const html = renderToStaticMarkup(<Page />);

      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(label);
    },
  );

  // #2046: ad-hoc ArrowLeft back-links normalised onto BackLink. The [id]-aware
  // targets carry a dynamic href (the parent is itself a drill-down record, not a
  // static hub) — the shared BackLink already takes an arbitrary href/label, so
  // the dynamic-parent variant needs no new component, only a resolved href.
  it("points the per-lodge Display settings sub-page back at its lodge (dynamic [id] parent)", async () => {
    const html = renderToStaticMarkup(
      await LodgeDisplaySettingsPage({
        params: Promise.resolve({ id: "lodge-42" }),
      }),
    );

    expect(html).toContain('href="/admin/lodges/lodge-42"');
    expect(html).toContain("← Lodge configuration");
  });

  it("points the Member detail header back at its caller-provided origin (dynamic returnTo parent)", () => {
    const html = renderToStaticMarkup(
      <MemberDetailHeader
        {...({
          member: {
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.test",
            accessRoles: [],
          },
          backHref: "/admin/members",
          backLabel: "Back to Members",
          isAdultMember: true,
          memberIsArchived: false,
          pendingDeleteRequest: undefined,
          xeroConnected: null,
          xeroPushing: false,
          xeroUnlinking: false,
          onOpenDependentDialog: () => {},
          onOpenLinkXero: () => {},
          onOpenCreateXero: () => {},
          onUnlinkXero: () => {},
        } as unknown as ComponentProps<typeof MemberDetailHeader>)}
      />,
    );

    expect(html).toContain('href="/admin/members"');
    expect(html).toContain("← Back to Members");
  });
});

// Other #2046 conversions render behind an async data fetch / loading gate, so
// they are not statically renderable here; their BackLink conversion is enforced
// by typecheck + lint (unused ArrowLeft/Link/Button imports would fail). They
// share the same dynamic-[id] BackLink pattern asserted above:
//   - src/app/(admin)/admin/lodges/[id]/page.tsx (error fallback → /admin/lodges)
//   - src/app/(admin)/admin/lodges/[id]/setup/page.tsx (→ lodge configuration)
//   - src/app/(admin)/admin/members/[id]/page.tsx (error fallback → returnTo)
//   - src/app/(admin)/admin/members/[id]/merge/page.tsx (→ master member)
//   - src/app/(admin)/admin/xero/records/[localModel]/[localId]/page.tsx (→ returnTo)
