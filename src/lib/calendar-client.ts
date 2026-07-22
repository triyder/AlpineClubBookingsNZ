import type { CalendarEventDTO } from "@/lib/calendar-events";

/**
 * Pure, client-safe date helpers for the month calendar. Everything here works
 * in the browser's local time — for a single-club NZ deployment that is the
 * lodge's own timezone, so an event created at "7pm" renders on the 7pm cell.
 * No server-only imports may be added to this module (it is bundled to the
 * client).
 */

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayLabels(): string[] {
  return WEEKDAY_LABELS;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Local `YYYY-MM-DD` key for grouping events onto day cells. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The 6×7 grid of days covering the given month, weeks starting Monday. The
 * leading/trailing days spill into the previous/next month so every week is
 * full — the standard month-calendar layout.
 */
export function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat. Convert to Monday-first offset (Mon=0..Sun=6).
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, i) => {
    return new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
  });
}

/** The inclusive [from, to] instants covering a month's full grid, for the API. */
export function monthGridRange(year: number, month: number): {
  from: Date;
  to: Date;
} {
  const grid = buildMonthGrid(year, month);
  const from = new Date(grid[0]);
  from.setHours(0, 0, 0, 0);
  const to = new Date(grid[grid.length - 1]);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Group events by their (local) start-day key. */
export function groupEventsByDay(
  events: CalendarEventDTO[],
): Map<string, CalendarEventDTO[]> {
  const byDay = new Map<string, CalendarEventDTO[]>();
  for (const event of events) {
    const key = dateKey(new Date(event.startsAt));
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      byDay.set(key, [event]);
    }
  }
  // All-day events first, then chronological.
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
    });
  }
  return byDay;
}

export function isSameMonth(date: Date, year: number, month: number): boolean {
  return date.getFullYear() === year && date.getMonth() === month;
}

export function isToday(date: Date): boolean {
  return dateKey(date) === dateKey(new Date());
}

export function formatMonthTitle(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NZ", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short chip/list label for an event's time ("All day", "7:00 pm"). */
export function formatEventTime(event: CalendarEventDTO): string {
  if (event.allDay) return "All day";
  return formatTime(event.startsAt);
}

export function formatEventDateLong(event: CalendarEventDTO): string {
  return new Date(event.startsAt).toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** `<input type="date">` value (local YYYY-MM-DD) for an ISO instant. */
export function toDateInputValue(iso: string): string {
  return dateKey(new Date(iso));
}

/** `<input type="time">` value (local HH:MM) for an ISO instant. */
export function toTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Build an ISO instant from local date + optional time inputs. */
export function isoFromDateTimeInputs(
  dateValue: string,
  timeValue?: string,
): string | null {
  if (!dateValue) return null;
  const composed = timeValue ? `${dateValue}T${timeValue}` : `${dateValue}T00:00`;
  const parsed = new Date(composed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Whether a save request should carry the recurrence rule.
 *
 * The rule is sent on create, when converting a standalone event to recurring,
 * and on a whole-series edit. It is dropped ONLY when editing a single
 * occurrence of an existing series (that path changes just this occurrence,
 * never the pattern). Extracted from the dialog so the exact decision that once
 * silently swallowed recurrence on create (#calendar-recurring) is unit-tested.
 */
export function shouldIncludeRecurrence(opts: {
  /** Selected repeat value ("NONE" or a frequency). */
  repeat: string;
  /** Editing an existing event (vs creating). */
  isEdit: boolean;
  /** The event being edited already belongs to a series. */
  isSeriesEvent: boolean;
  /** The chosen edit scope. */
  scope: "single" | "series";
}): boolean {
  if (opts.repeat === "NONE") return false;
  return !(opts.isEdit && opts.isSeriesEvent && opts.scope === "single");
}
