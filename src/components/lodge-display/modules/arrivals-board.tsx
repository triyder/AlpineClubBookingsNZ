import type { CSSProperties } from "react";
import type {
  DisplayState,
  DisplayStateBooking,
} from "@/lib/lodge-display-state";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  ARRIVALS_BOARD_MAX_NAMES,
  ARRIVALS_BOARD_NAME_STYLES,
  enumOption,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";

// The everyday bar board (fork issues #30/#56; visual reference:
// docs/lobby-display/mockups/everyday-bar-board.html). Pure function of the
// privacy-reduced DisplayState payload: room rows (or per-booking rows when
// allocation is off), one continuous bar per booking row across the NIGHTS it
// covers (the check-out morning is not a night — the mock's bars end the
// night before), up to N names then "+N", a weekday check-out label on each
// bar. Styling attaches via the display stylesheet through the display-*
// class hooks.

export interface BarLayout {
  startColumn: number; // 1-based grid column within the visible window
  spanColumns: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
  /** The bar's real last night is the window's first day (mock "dep"). */
  departing: boolean;
}

function nextDateOnly(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Compute a bar's grid placement within the visible window. stayEnd is the
 * CHECK-OUT date, so the bar's last occupied night is stayEnd - 1 (issue #56
 * — bars span nights, matching the mock). Exported for direct unit testing —
 * the maths is where clipping bugs live.
 */
export function computeBarLayout(
  row: { stayStart: string; stayEnd: string },
  windowDates: string[]
): BarLayout | null {
  if (windowDates.length === 0) return null;
  const first = windowDates[0];
  const last = windowDates[windowDates.length - 1];
  // No nights in window: checked out on/before the first day, or arrives
  // after the last day.
  if (row.stayEnd <= first || row.stayStart > last) return null;

  const startIndex = windowDates.findIndex((date) => date >= row.stayStart);
  const clampedStart = startIndex === -1 ? 0 : startIndex;
  let endIndex = clampedStart;
  for (let i = windowDates.length - 1; i >= clampedStart; i--) {
    if (windowDates[i] < row.stayEnd) {
      endIndex = i;
      break;
    }
  }

  return {
    startColumn: clampedStart + 1,
    spanColumns: Math.max(1, endIndex - clampedStart + 1),
    startsBeforeWindow: row.stayStart < first,
    // Checkout after the last window date → the stay runs past the board
    // (mock "out Mon 6 →" on a Fri–Sun window).
    endsAfterWindow: row.stayEnd > last,
    // Amber "checking out" treatment: last night is tonight AND the stay
    // began before the window — a same-day arrival stays green (mock Kea).
    departing:
      row.stayEnd === nextDateOnly(first) && row.stayStart < first,
  };
}

/** "Jane S, Rewi P +2" — up to max names, then an explicit overflow count. When
 * `leadOnly` (name-style: lead-count, mock A2) only the first guest shows, with
 * everyone else folded into the +N overflow ("Jane S +2"). */
export function barNames(
  row: DisplayStateBooking,
  maxNames: number,
  leadOnly = false
): { names: string[]; overflow: number } {
  if (!row.guests || row.guests.length === 0) {
    return { names: [row.label], overflow: 0 };
  }
  if (leadOnly) {
    return {
      names: [row.guests[0].label],
      overflow: Math.max(0, row.guests.length - 1),
    };
  }
  const names = row.guests.slice(0, maxNames).map((guest) => guest.label);
  return { names, overflow: Math.max(0, row.guests.length - names.length) };
}

export function windowDatesOf(state: DisplayState): string[] {
  return state.occupancy.map((day) => day.date);
}

function shortDay(date: string): string {
  const day = new Date(`${date}T00:00:00`);
  return `${day.toLocaleDateString("en-NZ", { weekday: "short" })} ${day.getDate()}`;
}

function formatDayHeading(date: string, index: number): string {
  return index === 0 ? `Tonight · ${shortDay(date)}` : shortDay(date);
}

/** "out Sun 12", "since Wed → out Sun 12", "out Tue 14 →". */
export function barMeta(
  row: { stayStart: string; stayEnd: string },
  layout: BarLayout
): string {
  const since = layout.startsBeforeWindow
    ? `since ${new Date(`${row.stayStart}T00:00:00`).toLocaleDateString("en-NZ", { weekday: "short" })} → `
    : "";
  return `${since}out ${shortDay(row.stayEnd)}${layout.endsAfterWindow ? " →" : ""}`;
}

/** Split "A - Kea" / "B Tui" style names into a letter tag + display name. */
export function splitRoomName(name: string): { tag: string | null; label: string } {
  const match = /^([A-Za-z0-9]{1,3})\s*[-–·:]\s+(.+)$/.exec(name.trim());
  if (!match) return { tag: null, label: name };
  return { tag: match[1], label: match[2] };
}

export function ArrivalsBoard({
  state,
  options,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const days = intOption(options, "days", ARRIVALS_BOARD_DEFAULT_DAYS, {
    min: 1,
    max: 7,
  });
  const maxNames = intOption(options, "max-names", ARRIVALS_BOARD_MAX_NAMES, {
    min: 1,
    max: 10,
  });
  const leadOnly =
    enumOption(options, "name-style", "names", ARRIVALS_BOARD_NAME_STYLES) ===
    "lead-count";
  const windowDates = windowDatesOf(state).slice(0, days);

  const rowGroups: Array<{ heading: string | null; rows: DisplayStateBooking[] }> =
    state.rooms === null
      ? [{ heading: null, rows: state.bookings }]
      : [
          ...state.rooms.map((room) => ({
            heading: room.name,
            rows: state.bookings.filter((row) => row.roomId === room.id),
          })),
          {
            heading: "Unassigned",
            rows: state.bookings.filter((row) => row.roomId === null),
          },
        ].filter((group) => group.rows.length > 0 || group.heading !== "Unassigned");

  return (
    <div
      className="display-arrivals-board"
      style={{ "--display-days": windowDates.length } as CSSProperties}
    >
      <div className="display-board-head" role="row">
        <span className="display-board-corner">Room</span>
        {windowDates.map((date, index) => (
          <span
            key={date}
            className="display-board-day"
            data-today={index === 0 || undefined}
            role="columnheader"
          >
            {formatDayHeading(date, index)}
          </span>
        ))}
      </div>
      {rowGroups.map((group, groupIndex) => {
        const room = group.heading === null ? null : splitRoomName(group.heading);
        return (
          <div className="display-board-row" key={group.heading ?? `group-${groupIndex}`}>
            {room !== null && (
              <span className="display-board-room" role="rowheader">
                {room.tag && <span className="display-board-room-tag">{room.tag}</span>}
                {room.label}
              </span>
            )}
            <div className="display-board-lanes">
              {group.rows.map((row) => {
                const layout = computeBarLayout(row, windowDates);
                if (!layout) return null;
                const { names, overflow } = barNames(row, maxNames, leadOnly);
                const grouped = row.guests === null;
                return (
                  <div
                    key={row.key}
                    className="display-bar"
                    data-group={grouped || undefined}
                    data-whole-lodge={row.wholeLodge || undefined}
                    data-departing={layout.departing || undefined}
                    data-starts-before={layout.startsBeforeWindow || undefined}
                    data-ends-after={layout.endsAfterWindow || undefined}
                    style={{
                      gridColumnStart: layout.startColumn,
                      gridColumnEnd: `span ${layout.spanColumns}`,
                    }}
                  >
                    <span className="display-bar-names">
                      {grouped ? `${row.label} · ${row.guestCount}` : names.join(", ")}
                      {overflow > 0 && (
                        <span className="display-bar-overflow"> +{overflow}</span>
                      )}
                    </span>
                    <span className="display-bar-out">{barMeta(row, layout)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
