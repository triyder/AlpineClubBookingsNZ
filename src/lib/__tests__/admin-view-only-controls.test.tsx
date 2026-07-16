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
