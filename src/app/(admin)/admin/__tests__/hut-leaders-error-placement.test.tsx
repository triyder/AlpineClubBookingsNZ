// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #1940: HutLeadersPage reads the session permission matrix for view-only
// gating; provide an edit-level admin session so the error-placement cases keep
// working.
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
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

vi.mock("@/components/admin/occupancy-calendar", () => ({
  OccupancyCalendar: ({
    mode,
    onSelectionChange,
  }: {
    mode: "range" | "single";
    onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  }) => (
    <div data-testid={`occupancy-calendar-${mode}`}>
      <button
        type="button"
        onClick={() =>
          onSelectionChange(
            mode === "range"
              ? { startDate: "2099-07-10", endDate: "2099-07-12" }
              : { startDate: "2099-07-11", endDate: "2099-07-11" },
          )
        }
      >
        Pick {mode}
      </button>
    </div>
  ),
}));

const OVERLAP_ERROR =
  "Assignment overlaps with Bob Jones's assignment (2026-07-10 to 2026-07-17) by 5 days. Maximum 1 day overlap is allowed for handover.";

const eligibleMember = {
  id: "m1",
  firstName: "Dana",
  lastName: "Diaz",
  email: "dana@test.com",
  hutLeaderEligible: true,
  hutLeaderEligibleAt: null,
  bookingCheckIn: "2099-07-10",
  bookingCheckOut: "2099-07-12",
  suggestedStartDate: "2099-07-10",
  suggestedEndDate: "2099-07-12",
  uncoveredNightCount: 3,
  fullyCovered: false,
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
      return { ok: true, json: async () => ({ members: [eligibleMember] }) };
    }
    if (url === "/api/admin/hut-leaders/unassigned-dates") {
      return { ok: true, json: async () => ({ unassignedDates: [] }) };
    }
    // The Confirm click POSTs the assignment; simulate a 409 overlap conflict.
    if (url === "/api/admin/hut-leaders" && method === "POST") {
      return { ok: false, json: async () => ({ error: OVERLAP_ERROR }) };
    }
    if (url === "/api/admin/hut-leaders") {
      return { ok: true, json: async () => ({ assignments: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("hut leaders assignment error placement", () => {
  it("surfaces a POST overlap error in the member card and the page-level alert", async () => {
    stubFetch();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;

    render(<HutLeadersPage />);

    // Calendar-first: pick a range to trigger the eligible-members fetch.
    fireEvent.click(await screen.findByRole("button", { name: /pick range/i }));

    // Wait for the member card to render, then select the member (step 2).
    const nameNode = await screen.findByText("Dana Diaz");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    // Confirm (step 3) -> POST returns the overlap error.
    fireEvent.click(await screen.findByRole("button", { name: /confirm assignment/i }));

    // Page-level alert shows the error immediately (the core fix).
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(OVERLAP_ERROR);
    });

    // The same error also renders inside the member's own card.
    const card = nameNode.closest("div.rounded-lg");
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(OVERLAP_ERROR);
  });
});
