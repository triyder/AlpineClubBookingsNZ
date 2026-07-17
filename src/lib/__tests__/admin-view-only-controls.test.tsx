// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

// useAdminAreaEditAccess reads the merged matrix off the session user; drive it
// per-test so the panels see a content:edit vs content:view admin.
let sessionMatrix: AdminPermissionMatrix | null = null;
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionMatrix
      ? { user: { id: "u1", adminPermissionMatrix: sessionMatrix } }
      : null,
  }),
}));

// SiteStyleWizard calls useRouter().refresh() after a save; the render-only
// cases here never save, so a stub router is enough.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Default matrix sets both content and lodge to `level`; pass overrides to
// split them (the LodgeInstructionsPanel cases below cross the two areas).
function matrix(
  level: "view" | "edit",
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: level,
    content: level,
    support: "view",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// URL-prefix-routed fetch stub. These are render-only case pairs, so every
// matched route answers with its canned body regardless of method; unknown
// URLs throw so a panel can never silently load nothing.
function stubFetchRoutes(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) {
          return jsonResponse(body);
        }
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

// Imported after the mock is registered.
import { SiteContentPanel } from "@/components/admin/site-content-panel";
import { PageContentPanel } from "@/components/admin/page-content-panel";
import { SiteBannersPanel } from "@/components/admin/site-banners-panel";
import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";
import { MountainConditionsPanel } from "@/app/(admin)/admin/mountain-conditions/_components/mountain-conditions-panel";
import { ImageManagerClient } from "@/app/(admin)/admin/image-manager/image-manager-client";
import { SiteStyleWizard } from "@/app/(admin)/admin/site-style/site-style-wizard";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";
// #1940 panels newly brought under the view-only pattern.
import { InductionSettingsPanel } from "@/components/admin/induction-settings-panel";
import { InductionTemplateManager } from "@/components/admin/induction-template-manager";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";
import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";
import { BookingMessagesPanel } from "@/components/admin/booking-messages/booking-messages-panel";
import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";
// #1940 pass 2 panels.
import { InternetBankingSettingsPanel } from "@/components/admin/internet-banking/internet-banking-settings-panel";
import { NotificationDeliveryPolicySettings } from "@/components/admin/email-settings/notification-delivery-policy-settings";
// #1940 pass 3 panels (support / finance / bookings settings editors).
import { AdminNotificationSettings } from "@/app/(admin)/admin/notifications/notifications-settings";
import AdminModulesPage from "@/app/(admin)/admin/modules/page";
import { MODULE_KEYS } from "@/config/modules";
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel";
import type { XeroRecordActivityData } from "@/lib/xero-record-types";
import AgeTierSettingsPage from "@/app/(admin)/admin/age-tier-settings/page";
import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client";

const SITE_CONTENT_DOCUMENTS = [
  { key: "FOOTER_BLURB", contentHtml: "<p>Blurb</p>", updatedAt: null },
  { key: "FOOTER_QUICK_LINKS", contentHtml: "<p>Links</p>", updatedAt: null },
  { key: "FOOTER_AFFILIATIONS", contentHtml: "<p>Affil</p>", updatedAt: null },
];

describe("view-only admin action controls", () => {
  it("disables write actions and exposes the read-only reason to AT", () => {
    render(
      <ViewOnlyActionButton canEdit={false}>Approve</ViewOnlyActionButton>,
    );

    const button = screen.getByRole("button", { name: /Approve/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });
});

describe("SiteContentPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(
            JSON.stringify({ documents: SITE_CONTENT_DOCUMENTS }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // PUT default: success (overridden per-test for the 403 case).
        return new Response(
          JSON.stringify({
            document: {
              key: "FOOTER_BLURB",
              contentHtml: "<p>Blurb</p>",
              updatedAt: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders read-only editors and disabled Save for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    expect(saveButtons.length).toBeGreaterThan(0);
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    // The read-only editor advertises its state.
    expect(
      screen.getAllByText(/View only — your admin role cannot edit/i).length,
    ).toBeGreaterThan(0);
  });

  it("renders enabled Save controls for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    expect(saveButtons.length).toBeGreaterThan(0);
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
  });

  it("surfaces a visible error when a save is rejected with 403", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });

    // Simulate a stale tab: the actor's content permission was narrowed after
    // the editors loaded, so the PUT now 403s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );

    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        ADMIN_FORBIDDEN_SAVE_REASON,
      );
    });
  });
});

describe("PageContentPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/page-content": {
        pages: [
          {
            id: "p1",
            slug: "trip-reports",
            caption: "Caption",
            menuTitle: "Trip Reports",
            title: "Trip Reports",
            headerText: "",
            path: "/trip-reports",
            sortOrder: 100,
            contentHtml: "<p>Body</p>",
            published: true,
            updatedAt: null,
            updatedByMemberId: null,
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Page and Hide for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<PageContentPanel />);

    expect(
      await screen.findByRole("button", { name: /Add Page/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Hide/i })).toBeDisabled();
    expect(
      screen.getByText(/can view page content but cannot change it/i),
    ).toBeInTheDocument();
  });

  it("enables Add Page and Hide for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<PageContentPanel />);

    expect(
      await screen.findByRole("button", { name: /Add Page/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Hide/i })).toBeEnabled();
  });
});

describe("SiteBannersPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/site-banners": {
        current: [
          {
            id: "b1",
            message: "Mountain closed",
            priority: "NOTIFY",
            startDate: "2026-07-01",
            endDate: "2026-07-31",
            active: true,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
        upcoming: [],
        past: [],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add banner, Deactivate, and Delete for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteBannersPanel />);

    expect(
      await screen.findByRole("button", { name: /Add banner/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Deactivate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/i })).toBeDisabled();
    expect(
      screen.getByText(/can view site banners but cannot change them/i),
    ).toBeInTheDocument();
  });

  it("enables Add banner, Deactivate, and Delete for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteBannersPanel />);

    expect(
      await screen.findByRole("button", { name: /Add banner/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Deactivate/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Delete/i })).toBeEnabled();
  });
});

describe("MountainConditionsPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/mountain-conditions": { record: null },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save, Save visibility, and upstream refresh for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<MountainConditionsPanel />);

    expect(
      await screen.findByRole("button", { name: /Update from upstream/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Save visibility/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByText(/can view mountain conditions but cannot change them/i),
    ).toBeInTheDocument();
  });

  it("enables Save, Save visibility, and upstream refresh for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<MountainConditionsPanel />);

    expect(
      await screen.findByRole("button", { name: /Update from upstream/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Save visibility/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("ImageManagerClient view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/image-manager/directories": { directories: [""] },
      "/api/admin/image-manager/images": { images: [] },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the read-only notice and disables uploads for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<ImageManagerClient />);

    await screen.findByText(/0 images in this directory/i);
    expect(
      screen.getByText("Uploading is disabled for your role."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can view images but cannot upload, delete, or change/i),
    ).toBeInTheDocument();
    // Write affordances use the accepted hidden-when-view-only idiom here.
    expect(
      screen.queryByTitle("New folder in current directory"),
    ).not.toBeInTheDocument();
  });

  it("shows live upload and folder controls for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<ImageManagerClient />);

    await screen.findByText(/0 images in this directory/i);
    expect(
      screen.getByText(/Drag & drop images here/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("New folder in current directory"),
    ).toBeEnabled();
  });
});

describe("SiteStyleWizard view-only gating (#1927)", () => {
  function wizardTheme() {
    return {
      ...DEFAULT_CLUB_THEME_VALUES,
      completedAt: null,
      contrastWarnings: [],
    };
  }

  beforeEach(() => {
    sessionMatrix = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Save and next and Reset neutral for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteStyleWizard initialTheme={wizardTheme()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save and next" }),
      ).toBeDisabled();
    });
    expect(
      screen.getByRole("button", { name: /Reset neutral/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the site style but cannot change it/i),
    ).toBeInTheDocument();
  });

  it("enables Save and next and Reset neutral for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteStyleWizard initialTheme={wizardTheme()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save and next" }),
      ).toBeEnabled();
    });
    expect(
      screen.getByRole("button", { name: /Reset neutral/i }),
    ).toBeEnabled();
  });
});

describe("LodgeInstructionsPanel area wiring (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
      "/api/admin/lodge-instructions": {
        documents: [
          { key: "OPEN", contentHtml: "<p>Open</p>", updatedAt: null },
          { key: "CLOSE", contentHtml: "<p>Close</p>", updatedAt: null },
          { key: "DAY_TO_DAY", contentHtml: "<p>Day</p>", updatedAt: null },
        ],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Pins the area string "lodge" in lodge-instructions-panel.tsx: the panel
  // must gate on lodge, NOT content. A lodge:view admin stays read-only even
  // with content:edit; a lodge:edit admin edits even with content:view. If
  // someone rewires the panel to useAdminAreaEditAccess("content"), both of
  // these cases fail.
  it("renders read-only for a lodge:view admin even with content:edit", async () => {
    sessionMatrix = matrix("edit", { lodge: "view" });
    render(<LodgeInstructionsPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /^Save /,
    });
    expect(saveButtons).toHaveLength(3);
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.getAllByText(/View only — your admin role cannot edit/i),
    ).toHaveLength(3);
    expect(
      screen.getByText(/can view lodge instructions but cannot change them/i),
    ).toBeInTheDocument();
  });

  it("renders editable for a lodge:edit admin even with content:view", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<LodgeInstructionsPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /^Save /,
    });
    expect(saveButtons).toHaveLength(3);
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
    expect(
      screen.queryByText(/View only — your admin role cannot edit/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #1940: view-only gating audit — panels that previously rendered enabled edit
// controls to a view-level admin. Each panel gates on its OWN route area.
// ---------------------------------------------------------------------------

describe("InductionSettingsPanel view-only gating (#1940, membership)", () => {
  const SETTINGS = {
    gateEnabled: false,
    minimumMembershipMonths: 6,
    minimumNights: 3,
    requiredSignOffs: 2,
    gateEffectiveFrom: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-nomination-settings": { settings: SETTINGS },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables editors and Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<InductionSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the nomination gate settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeEnabled();
  });

  it("surfaces a visible error when a save is rejected with 403", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionSettingsPanel />);

    const save = await screen.findByRole("button", { name: /Save settings/i });
    // Stale tab: the actor's membership permission was narrowed after load, so
    // the PUT now 403s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    fireEvent.click(save);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        ADMIN_FORBIDDEN_SAVE_REASON,
      );
    });
  });
});

describe("MembershipCancellationSettingsPanel view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-cancellation-settings": {
        settings: {
          warningText: "Warn",
          rejoinProcessText: "Rejoin",
          xeroArchiveContactsOnCancellation: false,
          xeroContactGroups: [],
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Group and Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MembershipCancellationSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add Group/i })).toBeDisabled();
    expect(
      screen.getByText(/can view membership cancellation settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Group and Save for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MembershipCancellationSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Add Group/i })).toBeEnabled();
  });
});

describe("InductionTemplateManager view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/induction-templates": {
        templates: [
          {
            id: "t1",
            name: "Lodge Induction",
            version: "1",
            kind: "NEW_MEMBER",
            isActive: false,
            createdAt: "2026-07-01T00:00:00.000Z",
            sectionCount: 1,
            inductionCount: 0,
            used: false,
          },
        ],
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Activate/Edit/Create for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<InductionTemplateManager />);

    expect(
      await screen.findByRole("button", { name: /Create blank/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Activate$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
    expect(
      screen.getByText(/can view induction templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Activate/Edit/Create for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionTemplateManager />);

    expect(
      await screen.findByRole("button", { name: /Create blank/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Activate$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });
});

describe("EmailMessageSettingsPanel view-only gating (#1940, support)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/email-settings": {
        settings: {
          clubName: "Club",
          bookingsName: "Bookings",
          emailFromName: "From",
          supportEmail: "s@example.com",
          contactEmail: "c@example.com",
          publicUrl: "https://example.com",
        },
      },
      "/api/admin/email-templates": {
        templates: [
          {
            key: "WELCOME",
            label: "Welcome",
            audience: "Member",
            defaultSubject: "Hi",
            defaultBody: "Body",
            allowedTokens: [],
            requiredTokens: [],
            triggerSummary: "On join",
            frequency: "Once",
            override: null,
          },
        ],
        staleOverrideCount: 0,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Email Settings and Save Template for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Email Settings/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Save Template/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view email settings and templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save controls for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Email Settings/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Save Template/i }),
    ).toBeEnabled();
  });
});

describe("BookingMessagesPanel view-only gating (#1940, support)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/booking-messages": {
        messages: [
          {
            key: "BOOKING_CONFIRM",
            section: "Booking",
            label: "Confirmation",
            description: "Sent on confirm",
            defaultBody: "Default",
            bodyText: "Body",
            tokens: [],
            override: null,
          },
        ],
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Message and Restore Default for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<BookingMessagesPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Message/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Restore Default/i }),
    ).toBeDisabled();
    // Preview is a pure read and stays enabled for a viewer.
    expect(screen.getByRole("button", { name: /Preview/i })).toBeEnabled();
    expect(
      screen.getByText(/can view booking messages but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save Message and Restore Default for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<BookingMessagesPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Message/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Restore Default/i }),
    ).toBeEnabled();
  });
});

describe("FinanceReportMappingsPanel view-only gating (#1940, finance)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/setup/finance-report-mappings": {
        categories: [],
        unmappedLines: [],
        snapshotCoverage: {
          latestProfitAndLossSnapshot: null,
          inspectedSnapshotCount: 0,
        },
      },
      "/api/admin/xero/chart-of-accounts": { accounts: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save and Backfill for a finance:view admin", async () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<FinanceReportMappingsPanel />);

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Backfill History/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the finance report mappings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save and Backfill for a finance:edit admin", async () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<FinanceReportMappingsPanel />);

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Backfill History/i }),
    ).toBeEnabled();
  });
});

describe("RoomsBedsManager view-only gating (#1940, bookings)", () => {
  const PAYLOAD = {
    rooms: [],
    capacity: {
      source: "configured_beds",
      capacity: 10,
      bedAllocationEnabled: true,
      activeBedCount: 10,
      fallbackCapacity: 10,
    },
    canImportFromConfig: false,
    configBeds: [],
  };

  beforeEach(() => {
    // This manager reads the matrix from its prop, not the session, but the
    // shared stub still needs the lodges + rooms endpoints.
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
      "/api/admin/bed-allocation/rooms": PAYLOAD,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Room for a bookings:view admin", async () => {
    render(<RoomsBedsManager permissionMatrix={matrix("view", { bookings: "view" })} />);

    expect(
      await screen.findByRole("button", { name: /Add Room/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view rooms and beds but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Room for a bookings:edit admin", async () => {
    render(<RoomsBedsManager permissionMatrix={matrix("view", { bookings: "edit" })} />);

    expect(
      await screen.findByRole("button", { name: /Add Room/i }),
    ).toBeEnabled();
  });
});

describe("InternetBankingSettingsPanel view-only gating (#1940, finance)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/internet-banking-settings": {
        settings: { holdBedSlots: true, holdDays: 3, minimumDaysBeforeCheckIn: 2 },
        moduleState: {
          xeroIntegrationEnabled: true,
          internetBankingPaymentsEnabled: true,
          ready: true,
        },
        holdPolicySummary: "Summary",
        xeroBehaviour: "Behaviour",
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Settings for a finance:view admin", async () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<InternetBankingSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Settings/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view Internet Banking settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save Settings for a finance:edit admin", async () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<InternetBankingSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Settings/i }),
    ).toBeEnabled();
  });
});

describe("NotificationDeliveryPolicySettings view-only gating (#1940, support)", () => {
  const POLICIES = [
    {
      templateName: "WELCOME",
      label: "Welcome",
      mode: "always" as const,
      defaultMode: "always" as const,
      deliveryEditable: true,
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the delivery-mode select for a support:view admin", () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<NotificationDeliveryPolicySettings initialPolicies={POLICIES} />);

    // The mode Select autosaves on change, so it must be disabled for a viewer.
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(
      screen.getByText(/can view notification delivery rules but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the delivery-mode select for a support:edit admin", () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<NotificationDeliveryPolicySettings initialPolicies={POLICIES} />);

    expect(screen.getByRole("combobox")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1940 pass 3: support / finance / bookings settings editors.
// ---------------------------------------------------------------------------

describe("AdminNotificationSettings view-only gating (#1940, support)", () => {
  const ADMINS = [
    {
      id: "a1",
      name: "Ada Admin",
      email: "ada@example.com",
      preferences: {
        adminNewBooking: true,
        adminPaymentFailure: true,
        adminPendingDeadline: true,
        adminBookingBumped: true,
        adminXeroSyncError: true,
        adminCapacityWarning: true,
        adminDailyDigest: true,
        adminWaitlistOffer: true,
        adminFamilyGroupRequest: true,
        adminBookingChangeRequest: true,
        adminRefundRequest: true,
        adminIssueReport: true,
        adminBookingRequest: true,
        adminBookingReviewRequired: true,
        adminMemberDeleteRequest: true,
      },
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the Edit button for a support:view admin", () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<AdminNotificationSettings initialAdmins={ADMINS} />);

    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
    expect(
      screen.getByText(
        /can view admin notification preferences but cannot change/i,
      ),
    ).toBeInTheDocument();
  });

  it("enables the Edit button for a support:edit admin", () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<AdminNotificationSettings initialAdmins={ADMINS} />);

    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });
});

describe("AdminModulesPage view-only gating (#1940, support)", () => {
  const MODULE_SETTINGS = Object.fromEntries(
    MODULE_KEYS.map((key) => [key, false]),
  );

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/modules": {
        settings: MODULE_SETTINGS,
        modules: [
          {
            key: MODULE_KEYS[0],
            label: "Test Module",
            description: "A module.",
            adminEnabled: false,
            effectiveEnabled: false,
            readiness: {
              status: "admin_disabled",
              message: "off",
              dependencies: [],
            },
          },
        ],
        updatedAt: null,
        updatedByMemberId: null,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the module toggle and Save for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<AdminModulesPage />);

    expect(await screen.findByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
    expect(
      screen.getByText(/can view the module settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the module toggle for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<AdminModulesPage />);

    expect(await screen.findByRole("checkbox")).toBeEnabled();
  });
});

describe("XeroRecordActivityPanel view-only gating (#1940, finance)", () => {
  const XERO_DATA = {
    rootRecord: { label: "Member X", localModel: "member", localId: "m1", url: null },
    summary: {
      totalOperations: 1,
      failedOperations: 1,
      partialOperations: 0,
      pendingOperations: 0,
      activeLinks: 0,
    },
    scopeRecords: [],
    relatedRecords: [],
    links: [],
    operations: [
      {
        id: "op1",
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "PUSH",
        createdAt: "2026-07-01T00:00:00.000Z",
        direction: "OUTBOUND",
        attemptCount: 1,
        localModel: "member",
        localId: "m1",
        localUrl: null,
        localLabel: "Member X",
        xeroObjectId: null,
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        lastErrorMessage: null,
        lastErrorCode: null,
        supported: true,
        reason: null,
        requestPayload: null,
        responsePayload: null,
      },
    ],
    inboundEvents: [],
  } as unknown as XeroRecordActivityData;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Retry in background for a finance:view admin", () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(
      <XeroRecordActivityPanel localModel="member" localId="m1" initialData={XERO_DATA} />,
    );

    expect(
      screen.getByRole("button", { name: /Retry in background/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view Xero activity but cannot retry or replay/i),
    ).toBeInTheDocument();
  });

  it("enables Retry in background for a finance:edit admin", () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(
      <XeroRecordActivityPanel localModel="member" localId="m1" initialData={XERO_DATA} />,
    );

    expect(
      screen.getByRole("button", { name: /Retry in background/i }),
    ).toBeEnabled();
  });
});

describe("AgeTierSettingsPage view-only gating (#1940, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/age-tier-settings": { settings: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the Edit button for a bookings:view admin", async () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<AgeTierSettingsPage />);

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the age tier settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the Edit button for a bookings:edit admin", async () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<AgeTierSettingsPage />);

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeEnabled();
  });
});

describe("PromoCodesPageClient view-only gating (#1940, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/promo-codes": [],
      "/api/admin/lodges": { lodges: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Promo Code for a bookings:view admin", async () => {
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix("view", { bookings: "view" })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Add Promo Code/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view promo codes but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Promo Code for a bookings:edit admin", async () => {
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix("view", { bookings: "edit" })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Add Promo Code/i }),
    ).toBeEnabled();
  });
});
