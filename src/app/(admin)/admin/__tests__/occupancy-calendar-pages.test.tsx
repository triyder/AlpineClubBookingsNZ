// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #1940: the Hut Leader / Roster pages read the session permission matrix for
// view-only gating; provide an edit-level admin session so the calendar-sync
// cases keep working.
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

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
      return { ok: true, json: async () => ({ members: [] }) };
    }
    if (url === "/api/admin/hut-leaders/unassigned-dates") {
      return { ok: true, json: async () => ({ unassignedDates: [] }) };
    }
    if (url === "/api/admin/hut-leaders") {
      return { ok: true, json: async () => ({ assignments: [] }) };
    }
    if (url.startsWith("/api/admin/roster/")) {
      return {
        ok: true,
        json: async () => ({
          date: "2099-07-11",
          guests: [],
          assignments: [],
          templates: [],
          guestHistory: {},
          guestCount: 0,
        }),
      };
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

describe("occupancy calendar page integration", () => {
  it("syncs Hut Leader date inputs from the range calendar", async () => {
    stubFetch();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;

    render(<HutLeadersPage />);
    // Calendar-first: the range picker is visible without opening a form.
    fireEvent.click(await screen.findByRole("button", { name: /pick range/i }));

    expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10");
    expect(screen.getByLabelText("End Date")).toHaveValue("2099-07-12");
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/hut-leaders/eligible-members?startDate=2099-07-10&endDate=2099-07-12",
      ),
    );
  });

  it("syncs the Roster date input from the single-date calendar", async () => {
    stubFetch();
    const RosterPage = (await import("@/app/(admin)/admin/roster/page")).default;

    render(<RosterPage />);
    fireEvent.click(await screen.findByRole("button", { name: /pick single/i }));

    expect(screen.getByLabelText("Date")).toHaveValue("2099-07-11");
    // Multi-lodge phase 8: the roster URL now carries `?lodgeId=` when a lodge
    // is selected, but this test has no `?lodgeId=` in the page location and
    // no lodges loaded (stubFetch does not stub /api/admin/lodges), so the
    // page's lodgeId state stays null and the query string is empty. The
    // fetch call also carries an AbortSignal (pre-existing abort-on-date-change
    // pattern, unrelated to lodge scoping).
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/roster/2099-07-11",
        expect.anything(),
      ),
    );
  });
});
