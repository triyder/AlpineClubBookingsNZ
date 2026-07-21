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
      annualFees: false,
    } }))));
    render(<PublicContentSettingsPanel />);

    const notice = await screen.findByText(/Content view access can inspect public visibility/);
    // "Annual membership fees" is the new dedicated {{annual-fees}} opt-in (#1933, E7).
    const checkbox = screen.getByRole("checkbox", { name: "Annual membership fees" });
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    // #2160: the reason moved into `AdminViewOnlySectionBanner`, so the notice
    // text now sits several levels below the id-carrying wrapper (banner box →
    // role="status" → wrapper) rather than directly inside it. The association
    // that matters is unchanged and is asserted directly: the element the
    // checkbox points at is the one that CONTAINS the explanation.
    const describedBy = checkbox.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reasonRegion = document.getElementById(String(describedBy));
    expect(reasonRegion).not.toBeNull();
    expect(reasonRegion?.contains(notice)).toBe(true);
    expect((screen.getByRole("button", { name: "Save visibility" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
