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

function matrix(level: "view" | "edit"): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: level,
    content: level,
    support: "view",
  };
}

// Imported after the mock is registered.
import { SiteContentPanel } from "@/components/admin/site-content-panel";

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
