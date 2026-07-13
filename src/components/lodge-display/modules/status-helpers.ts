// Shared stay-status derivation for the tonight/look-ahead display modules
// (room-cards, night-columns, status-board). Pure functions of the
// privacy-reduced DisplayState rows — no queries, no server imports.
//
// A stay is [stayStart, stayEnd) where stayEnd is the CHECK-OUT date and is
// EXCLUSIVE (the morning they leave — not a night). Dates are NZ date-only
// "YYYY-MM-DD" strings, so a plain string compare is a calendar compare.

export type StayStatus = "arriving" | "staying" | "departing";

/**
 * Classify a stay on one window date `date` (date-only string compare):
 * - `arriving`   — the stay starts on `date` (`stayStart === date`);
 * - `departing`  — `date` is the check-out morning (`stayEnd === date`);
 * - `staying`    — already in and staying again (`stayStart < date < stayEnd`);
 * - `null`       — the stay does not touch `date` at all.
 *
 * Arrival wins over departure for a same-day edge (a stay can't both start and
 * check out on the same date given an exclusive end, but the order is explicit
 * so the classification is total and deterministic).
 */
export function stayStatusOn(
  stay: { stayStart: string; stayEnd: string },
  date: string
): StayStatus | null {
  if (stay.stayStart === date) return "arriving";
  if (stay.stayEnd === date) return "departing";
  if (stay.stayStart < date && stay.stayEnd > date) return "staying";
  return null;
}

/** Rendering order within a status-grouped list: arrivals, then staying, then
 * departures — matching the approved mockups (O3/O4/C1a). */
export const STAY_STATUS_ORDER: Record<StayStatus, number> = {
  arriving: 0,
  staying: 1,
  departing: 2,
};

/** "Fri 10" — short weekday + day-of-month, NZ locale. Shared with the bar
 * boards' own private formatter; kept here so these modules never import from
 * arrivals-board (which a sibling change owns). */
export function shortDay(date: string): string {
  const day = new Date(`${date}T00:00:00`);
  return `${day.toLocaleDateString("en-NZ", { weekday: "short" })} ${day.getDate()}`;
}
