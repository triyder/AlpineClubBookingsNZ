// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => false,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { PublicContentSettingsPanel } from "@/components/admin/public-content-settings-panel";

describe("PublicContentSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("gives view-only users a visible and ARIA-associated explanation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ settings: {
      membershipTypes: false,
      entranceFees: false,
      hutFees: false,
      bookingPolicySummary: false,
      cancellationPolicy: false,
    } }))));
    render(<PublicContentSettingsPanel />);

    const notice = await screen.findByText(/Content view access can inspect public visibility/);
    const checkbox = screen.getByRole("checkbox", { name: "Membership types" });
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    expect(checkbox.getAttribute("aria-describedby")).toBe(notice.parentElement?.id);
    expect((screen.getByRole("button", { name: "Save visibility" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
