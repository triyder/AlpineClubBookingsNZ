import { formatDateOnly } from "@/lib/date-only";

/**
 * Date-only arithmetic for the edit panel's stay envelope.
 *
 * Moved verbatim from `edit-booking-panel.tsx` (#2690). Every value here is an
 * NZ date-only lodge night (`yyyy-mm-dd`), shifted through UTC midnight and
 * re-encoded by the shared `formatDateOnly` — never through a local-time Date,
 * which is what makes the day slide for a booker browsing from overseas.
 *
 * KNOWN DUPLICATION, CARRIED ACROSS DELIBERATELY AND NOT FIXED HERE (#2690
 * review). `shiftDateKey` and `shiftDateOnly` below are the same computation
 * written twice, and `addDaysDateOnly` in `@/lib/date-only` is a third copy of
 * it. They differ only in how they answer a date that will not parse:
 * `shiftDateKey` propagates the resulting `Invalid Date` into `formatDateOnly`,
 * while `shiftDateOnly` catches it and returns its input unchanged. That is a
 * behaviour difference, not a formatting one, so collapsing them is a behaviour
 * change and belongs to its own issue rather than to a no-behaviour-change
 * split. Both are exported so the divergence is visible to the next reader
 * instead of being hidden inside one module; do not add a fourth.
 */

export function shiftDateKey(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDateOnly(parsed);
}

/** All night keys (yyyy-mm-dd) from checkIn (inclusive) to checkOut (exclusive). */
export function eachNightKey(checkIn: string, checkOut: string): string[] {
  const keys: string[] = [];
  let current = checkIn;
  for (let i = 0; current < checkOut && i < 1000; i++) {
    keys.push(current);
    current = shiftDateKey(current, 1);
  }
  return keys;
}

export function shiftDateOnly(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}
