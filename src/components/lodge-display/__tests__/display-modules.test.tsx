// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import {
  ArrivalsBoard,
  barNames,
  computeBarLayout,
} from "@/components/lodge-display/modules/arrivals-board";
import { OccupancyGrid } from "@/components/lodge-display/modules/occupancy-grid";
import { SinglesBoard } from "@/components/lodge-display/modules/singles-board";
import { WelcomePanel } from "@/components/lodge-display/modules/welcome-panel";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";
import { intOption } from "@/components/lodge-display/modules/module-options";

// Issue #30 (LTV-005): the booking/occupancy display modules — pure functions
// of the privacy-reduced DisplayState. Fixtures mirror the payload the
// serialiser emits; no module ever queries anything.

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

function row(overrides: Partial<DisplayStateBooking>): DisplayStateBooking {
  return {
    key: "row-1-0",
    label: "Olive O",
    wholeLodge: false,
    roomId: null,
    guests: [
      { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
    ],
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
    occupancy: WINDOW.map((date) => ({
      date,
      arriving: 0,
      departing: 0,
      staying: 0,
    })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  };
}

describe("bar layout maths (clipping regression surface)", () => {
  // stayEnd is the CHECK-OUT date (issue #56): a bar occupies nights
  // stayStart .. stayEnd-1, matching the approved mock.
  it("places an in-window stay on its nights only (checkout morning excluded)", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-14", stayEnd: "2026-04-15" }, WINDOW)
    ).toEqual({
      startColumn: 2,
      spanColumns: 1,
      startsBeforeWindow: false,
      endsAfterWindow: false,
      departing: false,
    });
  });

  it("clamps stays that started earlier or run past the window, and flags them", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-20" }, WINDOW)
    ).toEqual({
      startColumn: 1,
      spanColumns: 3,
      startsBeforeWindow: true,
      endsAfterWindow: true,
      departing: false,
    });
  });

  it("marks a stay whose last night is tonight as departing (amber treatment)", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-14" }, WINDOW)
    ).toEqual({
      startColumn: 1,
      spanColumns: 1,
      startsBeforeWindow: true,
      endsAfterWindow: false,
      departing: true,
    });
  });

  it("does NOT mark a same-day arrival leaving tomorrow as departing (mock Kea stays green)", () => {
    const layout = computeBarLayout(
      { stayStart: "2026-04-13", stayEnd: "2026-04-14" },
      WINDOW
    );
    expect(layout).toMatchObject({ spanColumns: 1, departing: false });
  });

  it("returns null when there are no nights in the window", () => {
    // Entirely after the window.
    expect(
      computeBarLayout({ stayStart: "2026-05-01", stayEnd: "2026-05-03" }, WINDOW)
    ).toBeNull();
    // Checks out on the window's first morning — no night tonight.
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-13" }, WINDOW)
    ).toBeNull();
  });
});

describe("bar names overflow (AC2)", () => {
  it("shows up to the max then an explicit +N", () => {
    const guests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    const result = barNames(row({ guests, guestCount: 7 }), 5);
    expect(result.names).toHaveLength(5);
    expect(result.overflow).toBe(2);
  });

  it("falls back to the booking label when names are withheld", () => {
    const result = barNames(row({ guests: null, label: "Harakeke College", guestCount: 14 }), 5);
    expect(result.names).toEqual(["Harakeke College"]);
    expect(result.overflow).toBe(0);
  });

  it("lead-count style (A2) shows only the lead name + everyone else as +N", () => {
    const guests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    const result = barNames(row({ guests, guestCount: 7 }), 5, true);
    expect(result.names).toEqual(["A X"]);
    expect(result.overflow).toBe(6);
  });
});

describe("ArrivalsBoard name-style option (A2)", () => {
  it("renders the lead name + count when name-style=lead-count", () => {
    const guests = ["Alex B", "Sam R", "Jo K"].map((label) => ({
      label,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 3 })] })}
        options={{ "name-style": "lead-count" }}
      />
    );
    expect(screen.getByText("Alex B")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
    expect(screen.queryByText("Sam R")).toBeNull();
  });

  it("falls back to full names on an unknown name-style (AC6)", () => {
    const guests = ["Alex B", "Sam R"].map((label) => ({
      label,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 2 })] })}
        options={{ "name-style": "banana" }}
      />
    );
    expect(screen.getByText("Alex B, Sam R")).toBeDefined();
  });
});

describe("ArrivalsBoard", () => {
  it("renders room rows when allocation is on, including an Unassigned lane", () => {
    render(
      <ArrivalsBoard
        state={state({
          rooms: [
            { id: "r1", name: "Kea" },
            { id: "r2", name: "Tui" },
          ],
          bookings: [
            row({ key: "a", roomId: "r1" }),
            row({ key: "b", roomId: null, label: "Rewi P" }),
          ],
        })}
      />
    );
    expect(screen.getByText("Kea")).toBeDefined();
    expect(screen.getByText("Unassigned")).toBeDefined();
    expect(screen.queryByText("Tui")).toBeDefined(); // empty room still shows its lane
  });

  it("renders overflow with an explicit +N and never throws on bad options (AC6)", () => {
    const guests = ["A", "B", "C", "D", "E", "F"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 6 })] })}
        options={{ days: "banana", "max-names": -3 }}
      />
    );
    // max-names clamps to 1 → 5 overflow
    expect(screen.getByText("+5")).toBeDefined();
  });
});

describe("OccupancyGrid / WelcomePanel (whole-lodge treatment, AC3/AC5)", () => {
  const blockoutState = state({
    bookings: [
      row({
        wholeLodge: true,
        label: "Harakeke College",
        guests: null,
        guestCount: 14,
        stayEnd: "2026-04-15",
      }),
    ],
  });

  it("blockout shows the group label only — no individual names exist to leak", () => {
    const { container } = render(<OccupancyGrid state={blockoutState} />);
    expect(screen.getByText("Harakeke College")).toBeDefined();
    expect(container.textContent).toContain("14 guests");
  });

  it("welcome renders with zero options and greets the group when present", () => {
    render(<WelcomePanel state={blockoutState} />);
    expect(screen.getByText(/Welcome to Silverpeak Lodge/)).toBeDefined();
    expect(screen.getByText("Harakeke College")).toBeDefined();
  });

  it("welcome shows the mock's info tiles for the group (issue #58)", () => {
    const { container } = render(
      <WelcomePanel
        state={{
          ...blockoutState,
          config: { "whole-lodge-note": "See your group leader" },
        }}
      />
    );
    expect(screen.getByText("Group")).toBeDefined();
    expect(screen.getByText("Staying")).toBeDefined();
    expect(screen.getByText("See your group leader")).toBeDefined();
    expect(container.querySelectorAll(".display-welcome-tile").length).toBe(3);
  });

  it("statement variant (no rooms) renders the block statement with a week strip (issue #58)", () => {
    const { container } = render(<OccupancyGrid state={blockoutState} />);
    expect(screen.getByText("The lodge is fully booked")).toBeDefined();
    expect(container.querySelectorAll(".display-week-day").length).toBe(3);
  });

  it("variant=statement forces the summary + week strip even when rooms exist (B1b)", () => {
    const withRooms = state({
      rooms: [
        { id: "room-1", name: "A - Kea" },
        { id: "room-2", name: "B - Tui" },
      ],
      bookings: [
        row({
          wholeLodge: true,
          label: "Harakeke College",
          guests: null,
          guestCount: 14,
          stayEnd: "2026-04-15",
        }),
      ],
    });
    const { container } = render(
      <OccupancyGrid state={withRooms} options={{ variant: "statement" }} />
    );
    // Forced statement look, not the room-grid board, despite rooms being set.
    expect(screen.getByText("The lodge is fully booked")).toBeDefined();
    expect(container.querySelectorAll(".display-week-day").length).toBe(3);
    expect(container.querySelector(".display-blockout-board")).toBeNull();
  });

  it("board variant blocks only the booked nights and keeps other bars (part-week, issue #58)", () => {
    const partWeek = state({
      rooms: [
        { id: "room-1", name: "A - Kea" },
        { id: "room-2", name: "B - Tui" },
      ],
      bookings: [
        row({
          key: "row-wl",
          wholeLodge: true,
          label: "Harakeke College",
          guests: null,
          guestCount: 42,
          roomId: null,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15", // nights 13+14; the 15th is free
        }),
        row({
          key: "row-jess",
          label: "Jess L",
          guests: [
            { label: "Jess L", stayStart: "2026-04-15", stayEnd: "2026-04-16" },
          ],
          guestCount: 1,
          roomId: "room-2",
          stayStart: "2026-04-15",
          stayEnd: "2026-04-16",
        }),
      ],
    });
    const { container } = render(<OccupancyGrid state={partWeek} />);
    const block = container.querySelector(".display-blockout-panel") as HTMLElement;
    expect(block).not.toBeNull();
    // Columns 2..3 (nights 13+14) — column 4 (the 15th) stays free.
    expect(block.style.gridColumnStart).toBe("2");
    expect(block.style.gridColumnEnd).toBe("span 2");
    expect(screen.getByText("Jess L")).toBeDefined();
    // The room with a live bar lights up; the held room stays dimmed.
    const rooms = container.querySelectorAll(".display-board-room");
    expect(rooms[1].hasAttribute("data-live")).toBe(true);
    expect(rooms[0].hasAttribute("data-live")).toBe(false);
  });
});

describe("SinglesBoard (AC4)", () => {
  it("renders one row per guest with their own check-out when rooms is null", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [
            row({
              guests: [
                { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
                { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
              ],
              guestCount: 2,
            }),
          ],
        })}
      />
    );
    expect(screen.getByText("Jane S")).toBeDefined();
    // Weekday out labels (issue #58) — each guest keeps their own check-out.
    expect(screen.getByText("out Tue 14")).toBeDefined();
    expect(screen.getByText("out Wed 15")).toBeDefined();
  });

  it("keeps reduced labels for counts-only rows", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [row({ guests: null, label: "Guests · 3", guestCount: 3 })],
        })}
      />
    );
    expect(screen.getByText(/Guests · 3/)).toBeDefined();
  });
});

describe("module map and options (AC6/AC7)", () => {
  it("maps this task's four registry names to components (later tasks add theirs)", () => {
    const keys = Object.keys(DISPLAY_MODULE_COMPONENTS);
    for (const name of ["arrivals-board", "occupancy-grid", "singles-board", "welcome"]) {
      expect(keys).toContain(name);
    }
  });

  it("intOption clamps and falls back per documented defaults", () => {
    expect(intOption(undefined, "days", 3, { min: 1, max: 7 })).toBe(3);
    expect(intOption({ days: "4" }, "days", 3, { min: 1, max: 7 })).toBe(4);
    expect(intOption({ days: 99 }, "days", 3, { min: 1, max: 7 })).toBe(7);
    expect(intOption({ days: "banana" }, "days", 3, { min: 1, max: 7 })).toBe(3);
  });
});
