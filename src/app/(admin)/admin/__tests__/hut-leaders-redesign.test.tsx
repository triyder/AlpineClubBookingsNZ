// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the props the page passes to the (mocked) calendar so we can assert on
// the computed overlay, and drive selection / month-change from the test.
const calendar = vi.hoisted(() => ({ lastProps: null as Record<string, unknown> | null }));

// #1940: HutLeadersPage reads the session permission matrix for view-only
// gating; provide an edit-level admin session so the flow cases keep working.
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
  OccupancyCalendar: (props: {
    onSelectionChange: (s: { startDate: string; endDate: string }) => void;
    onVisibleMonthChange?: (month: string) => void;
  }) => {
    calendar.lastProps = props as unknown as Record<string, unknown>;
    return (
      <div data-testid="calendar">
        <button
          type="button"
          onClick={() =>
            props.onSelectionChange({ startDate: "2099-07-10", endDate: "2099-07-12" })
          }
        >
          Pick range
        </button>
        <button type="button" onClick={() => props.onVisibleMonthChange?.("2099-07")}>
          Load July 2099
        </button>
      </div>
    );
  },
}));

// Simple stub mirroring how the calendar is mocked: a button that selects a
// fixed member with NO booking (the no-booking custodian path).
vi.mock("@/components/admin/member-picker", () => ({
  MemberPicker: ({
    onSelect,
  }: {
    onSelect: (m: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      ageTier: string;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({
          id: "any1",
          firstName: "Casey",
          lastName: "Nomad",
          email: "casey@test.com",
          ageTier: "ADULT",
        })
      }
    >
      Pick any member
    </button>
  ),
}));

type Assignment = {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
};

function stubFetch(opts: {
  assignments?: Assignment[];
  monthRed?: Array<{ date: string; bookingCount: number; guestCount: number }>;
  occupancyNights?: Array<{ date: string; guestCount: number }>;
}) {
  const assignments = opts.assignments ?? [];
  const monthRed = opts.monthRed ?? [];
  const occupancyNights = opts.occupancyNights ?? [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
      return { ok: true, json: async () => ({ members: [] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders/unassigned-dates?month=")) {
      return { ok: true, json: async () => ({ unassignedDates: monthRed }) };
    }
    if (url === "/api/admin/hut-leaders/unassigned-dates") {
      return { ok: true, json: async () => ({ unassignedDates: [] }) };
    }
    if (url.startsWith("/api/admin/occupancy")) {
      return { ok: true, json: async () => ({ nights: occupancyNights }) };
    }
    if (url === "/api/admin/hut-leaders" && method === "POST") {
      return { ok: true, json: async () => ({ id: "new-1", emailSent: true }) };
    }
    if (url === "/api/admin/hut-leaders") {
      return { ok: true, json: async () => ({ assignments }) };
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
  calendar.lastProps = null;
});

describe("hut leaders redesign — calendar-painted 3-step flow", () => {
  it("disables Confirm when the chosen range conflicts >1 day with an existing assignment", async () => {
    stubFetch({
      assignments: [
        {
          id: "a1",
          memberId: "m9",
          memberName: "Bob Jones",
          memberEmail: "bob@test.com",
          startDate: "2099-07-08",
          endDate: "2099-07-14",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;
    render(<HutLeadersPage />);

    // Step 1: pick 2099-07-10..12, which overlaps Bob's 08–14 block by 3 days.
    fireEvent.click(await screen.findByRole("button", { name: /pick range/i }));
    // Step 2: assign any member (keeps the picked range).
    fireEvent.click(await screen.findByRole("button", { name: "Any member" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick any member" }));

    // Step 3: Confirm is blocked and the reason names the conflicting leader.
    const confirmBtn = await screen.findByRole("button", { name: /confirm assignment/i });
    await waitFor(() => expect(confirmBtn).toBeDisabled());
    expect(screen.getByText(/Overlaps Bob Jones/)).toBeInTheDocument();
  });

  it("assigns a member with NO booking via the Any member tab and posts the picked range", async () => {
    const fetchMock = stubFetch({ assignments: [] });
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;
    render(<HutLeadersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /pick range/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Any member" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick any member" }));

    const confirmBtn = await screen.findByRole("button", { name: /confirm assignment/i });
    await waitFor(() => expect(confirmBtn).toBeEnabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([u, init]) =>
          u === "/api/admin/hut-leaders" &&
          ((init as RequestInit | undefined)?.method ?? "").toUpperCase() === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(
        JSON.parse((postCall![1] as RequestInit).body as string),
      ).toMatchObject({
        memberId: "any1",
        startDate: "2099-07-10",
        endDate: "2099-07-12",
      });
    });
  });

  it("wires violet (covered) and red (needs-leader) overlay data to the calendar on month change", async () => {
    const fetchMock = stubFetch({
      assignments: [
        {
          id: "a1",
          memberId: "m9",
          memberName: "Bob Jones",
          memberEmail: "bob@test.com",
          startDate: "2099-07-15",
          endDate: "2099-07-17",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      monthRed: [{ date: "2099-07-20", bookingCount: 1, guestCount: 2 }],
      occupancyNights: [{ date: "2099-07-15", guestCount: 3 }],
    });
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;
    render(<HutLeadersPage />);

    // Navigate the calendar to July 2099.
    fireEvent.click(await screen.findByRole("button", { name: /load july 2099/i }));

    // The month change fetches the windowed red set and re-fetches assignments.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/hut-leaders/unassigned-dates?month=2099-07",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/hut-leaders");

    // The page computes and passes a violet (covered) + red (needs-leader) overlay.
    await waitFor(() => {
      const overlay =
        (calendar.lastProps?.overlayByDate as Record<
          string,
          { tone: string; emphasis?: string }
        >) ?? {};
      expect(overlay["2099-07-20"]).toMatchObject({ tone: "red" });
      expect(overlay["2099-07-15"]).toMatchObject({ tone: "violet" });
    });
  });
});
