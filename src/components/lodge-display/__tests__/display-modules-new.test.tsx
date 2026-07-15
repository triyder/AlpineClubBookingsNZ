// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import { RoomCards } from "@/components/lodge-display/modules/room-cards";
import { NightColumns } from "@/components/lodge-display/modules/night-columns";
import { StatusBoard } from "@/components/lodge-display/modules/status-board";

// Issue #115 (closes #114): the tonight / look-ahead / status modules — pure
// functions of the privacy-reduced DisplayState. Fixtures mirror the serialiser
// payload; no module queries anything. tonight = window.start = 2026-04-13.

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

function row(overrides: Partial<DisplayStateBooking>): DisplayStateBooking {
  return {
    key: "row-1-0",
    label: "Olive O",
    wholeLodge: false,
    roomId: null,
    guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }],
    guestCount: 1,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
    ...overrides,
  };
}

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW.map((date) => ({ date, arriving: 0, departing: 0, staying: 0 })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  };
}

/** The data-status on the dot in the nearest row/person ancestor of `text`.
 * Walks up from the text node and stops at the first ancestor that holds a dot,
 * which is the row itself — so a sibling row's dot is never matched. */
function statusOf(scope: HTMLElement, text: string, dotClass: string): string | null {
  const el = within(scope).getByText(text);
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== scope.parentElement) {
    const dot = node.querySelector(`.${dotClass}`);
    if (dot) return dot.getAttribute("data-status");
    node = node.parentElement;
  }
  return null;
}

describe("RoomCards (mock O2)", () => {
  const rooms = [
    { id: "r1", name: "Kea" },
    { id: "r2", name: "Tui" },
    { id: "r3", name: "Snowline" },
  ];
  const fixture = state({
    rooms,
    bookings: [
      // r1: an arriving guest + an already-staying guest → count 2.
      row({ key: "a", roomId: "r1", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] }),
      row({ key: "a2", roomId: "r1", guests: [{ label: "Tom B", stayStart: "2026-04-12", stayEnd: "2026-04-15" }] }),
      // r2: a guest checking out this morning + a withheld group arriving.
      row({ key: "b", roomId: "r2", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
      row({ key: "c", roomId: "r2", guests: null, label: "Harakeke College", guestCount: 14 }),
      // r3: nobody → free card.
    ],
  });

  it("names guests, shows a withheld booking as label + count, never inventing names", () => {
    const { container } = render(<RoomCards state={fixture} />);
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(screen.getByText("Tom B")).toBeDefined();
    expect(container.textContent).toContain("Harakeke College · 14");
  });

  it("classifies arrive / stay / depart with the shared status dot", () => {
    const { container } = render(<RoomCards state={fixture} />);
    const board = container as unknown as HTMLElement;
    expect(statusOf(board, "Jane S", "display-room-dot")).toBe("arriving");
    expect(statusOf(board, "Tom B", "display-room-dot")).toBe("staying");
    expect(statusOf(board, "Dave L", "display-room-dot")).toBe("departing");
  });

  it("renders a dashed free card for an empty room and counts headcount (group counts its guests)", () => {
    const { container } = render(<RoomCards state={fixture} />);
    expect(screen.getByText("Snowline — free")).toBeDefined();
    expect(container.querySelector(".display-room-card-empty")).not.toBeNull();
    // r1 has two named guests tonight.
    const counts = Array.from(container.querySelectorAll(".display-room-card-count")).map(
      (n) => n.textContent
    );
    expect(counts).toContain("2 guests");
  });

  it("degrades to a note (not a crash) when bed allocation is off", () => {
    const { container } = render(<RoomCards state={state({ rooms: null, bookings: [row({})] })} />);
    expect(container.querySelector(".display-room-cards-fallback")).not.toBeNull();
    expect(screen.getByText(/needs bed allocation/)).toBeDefined();
    expect(container.querySelector(".display-room-card")).toBeNull();
  });
});

describe("NightColumns (mocks O3 / C1a)", () => {
  const rooms = [
    { id: "r1", name: "Kea" },
    { id: "r2", name: "Ruru" },
    { id: "r3", name: "Pukeko" },
  ];
  const fixture = state({
    rooms,
    occupancy: [
      { date: "2026-04-13", arriving: 2, departing: 1, staying: 3 },
      { date: "2026-04-14", arriving: 2, departing: 1, staying: 4 },
      { date: "2026-04-15", arriving: 0, departing: 2, staying: 2 },
    ],
    bookings: [
      // Named party of two, in all three columns (arrive → stay → depart).
      row({ key: "a", roomId: "r1", guests: [
        { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
        { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
      ], guestCount: 2 }),
      // Withheld group arriving on the second night only.
      row({ key: "b", roomId: "r2", guests: null, label: "Alpine Skills", guestCount: 14, stayStart: "2026-04-14", stayEnd: "2026-04-15" }),
      // Guest checking out tonight.
      row({ key: "c", roomId: "r3", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
    ],
  });

  it("marks the today column and shows occupancy counts (with 'N new' on later nights)", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const today = container.querySelector(".display-night-col-today") as HTMLElement;
    expect(today).not.toBeNull();
    expect(within(today).getByText(/Tonight/)).toBeDefined();
    expect(within(today).getByText("3 in")).toBeDefined();
    // Second column carries the arrivals delta.
    expect(screen.getByText("4 in · 2 new")).toBeDefined();
  });

  it("collapses a booking to lead name + overflow, a withheld booking to label + count", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const today = container.querySelector(".display-night-col-today") as HTMLElement;
    expect(within(today).getByText("Jane S +1")).toBeDefined();
    // The group is not in tonight's column but appears on its arrival + stay nights.
    expect(within(today).queryByText(/Alpine Skills/)).toBeNull();
    expect(screen.getAllByText("Alpine Skills · 14").length).toBeGreaterThan(0);
  });

  it("classifies arrive / stay / depart per night and annotates the room (C1a)", () => {
    const { container } = render(<NightColumns state={fixture} />);
    const cols = container.querySelectorAll(".display-night-col");
    // Tonight: Jane arriving; Dave departing.
    expect(statusOf(cols[0] as HTMLElement, "Jane S +1", "display-night-dot")).toBe("arriving");
    expect(statusOf(cols[0] as HTMLElement, "Dave L", "display-night-dot")).toBe("departing");
    // Last night: Jane departing (checkout 15th).
    expect(statusOf(cols[2] as HTMLElement, "Jane S +1", "display-night-dot")).toBe("departing");
    // Room annotation present with allocation on.
    expect(within(cols[0] as HTMLElement).getByText("Kea")).toBeDefined();
  });

  it("hides room annotations when show-rooms is off (plain O3 look-ahead)", () => {
    const { container } = render(<NightColumns state={fixture} options={{ "show-rooms": false }} />);
    expect(container.querySelector(".display-night-room")).toBeNull();
    expect(screen.getAllByText("Jane S +1").length).toBeGreaterThan(0);
  });

  it("shows an empty-night placeholder and never throws on bad options", () => {
    const soloTonight = state({
      bookings: [row({ key: "x", guests: [{ label: "Solo P", stayStart: "2026-04-13", stayEnd: "2026-04-14" }], stayStart: "2026-04-13", stayEnd: "2026-04-14" })],
    });
    const { container } = render(<NightColumns state={soloTonight} options={{ days: "banana" }} />);
    // days falls back to 3 → three columns; the 15th is empty.
    expect(container.querySelectorAll(".display-night-col").length).toBe(3);
    expect(container.querySelector(".display-night-empty")).not.toBeNull();
  });
});

describe("StatusBoard (mock O4, closes #114)", () => {
  const fixture = state({
    bookings: [
      row({ key: "a", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] }),
      row({ key: "b", guests: [{ label: "Ruth K", stayStart: "2026-04-12", stayEnd: "2026-04-15" }], stayStart: "2026-04-12", stayEnd: "2026-04-15" }),
      row({ key: "c", guests: [{ label: "Dave L", stayStart: "2026-04-10", stayEnd: "2026-04-13" }], stayStart: "2026-04-10", stayEnd: "2026-04-13" }),
      row({ key: "d", guests: null, label: "Nguyen family", guestCount: 4, stayStart: "2026-04-13", stayEnd: "2026-04-15" }),
    ],
  });

  it("groups tonight's bookings into Arriving / Staying / Leaving by status", () => {
    const { container } = render(<StatusBoard state={fixture} />);
    const groups = container.querySelectorAll(".display-status-group");
    const arriving = Array.from(groups).find((g) => g.getAttribute("data-status") === "arriving") as HTMLElement;
    const staying = Array.from(groups).find((g) => g.getAttribute("data-status") === "staying") as HTMLElement;
    const leaving = Array.from(groups).find((g) => g.getAttribute("data-status") === "departing") as HTMLElement;
    expect(within(arriving).getByText("Jane S")).toBeDefined();
    expect(within(arriving).getByText("Nguyen family · 4")).toBeDefined();
    expect(within(staying).getByText("Ruth K")).toBeDefined();
    expect(within(leaving).getByText("Dave L")).toBeDefined();
  });

  it("shows a withheld booking as label + count, never invented names", () => {
    const { container } = render(<StatusBoard state={fixture} />);
    expect(container.textContent).toContain("Nguyen family · 4");
  });

  it("renders an empty-group placeholder for a status with no bookings", () => {
    const arrivalsOnly = state({
      bookings: [row({ key: "a", guests: [{ label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" }] })],
    });
    const { container } = render(<StatusBoard state={arrivalsOnly} />);
    // Staying and Leaving are both empty.
    expect(container.querySelectorAll(".display-status-empty").length).toBe(2);
  });

  it("is room-agnostic: renders identically whether or not bed allocation is on", () => {
    const withRooms = { ...fixture, rooms: [{ id: "r1", name: "Kea" }] };
    const { container } = render(<StatusBoard state={withRooms} />);
    expect(screen.getByText("Jane S")).toBeDefined();
    expect(container.querySelectorAll(".display-status-group").length).toBe(3);
  });
});
