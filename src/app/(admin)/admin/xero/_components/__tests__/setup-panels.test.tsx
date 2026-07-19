// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #2108: a basic render/mode smoke test for the Import Members panel (the file
// was previously untested). It confirms the mode selector renders, the default
// "Age tiers" mode shows the age-tier controls, and the Import button is
// disabled until a group is mapped.

const mockLoadGroups = vi.fn();
vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: (...a: unknown[]) => mockLoadGroups(...a),
}));

const mockFetchJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: vi.fn(),
}));

import { SetupPanels } from "../setup-panels";

function renderPanel() {
  return render(
    <SetupPanels
      connected
      open
      onToggle={vi.fn()}
      clubName="Test Club"
      bookingsName="Bookings"
      syncing={null}
      setSyncing={vi.fn()}
      setSyncResult={vi.fn()}
      onMessage={vi.fn()}
      onRefreshOperations={vi.fn()}
      onRefreshDiagnostics={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadGroups.mockResolvedValue({
    groups: [{ id: "group_1", name: "Adults", contactCount: 3 }],
  });
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url === "/api/admin/membership-types") {
      return {
        membershipTypes: [
          { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: ["ADULT"] },
          { id: "type_org", name: "School", isActive: true, allowedAgeTiers: ["NOT_APPLICABLE"] },
        ],
      };
    }
    return {};
  });
});

describe("SetupPanels — Import Members mode (#2108)", () => {
  it("renders the mode selector and defaults to Age tiers with the Import button disabled", async () => {
    renderPanel();

    // Groups load from the mocked contact-group loader.
    await waitFor(() => expect(screen.getByText("Adults")).toBeTruthy());

    // The mode selector is present and defaults to Age tiers, with an age-tier
    // control rendered per group.
    expect(screen.getByText("Map groups to")).toBeTruthy();
    expect(screen.getByText("Age tiers")).toBeTruthy();
    expect(screen.getByLabelText("Age tier for Adults")).toBeTruthy();

    // Import is disabled until a group is fully mapped (default tier is Skip).
    const importButton = screen.getByRole("button", {
      name: /import members/i,
    }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
  });
});
