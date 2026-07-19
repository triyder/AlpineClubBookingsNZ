// Disjoint Monday–Wednesday stay windows for the booking persona, starting a
// few weeks out so they clear the demo seed's relative bookings. Windows are
// pure date math (NZ date-only lodge nights); the wizard itself rejects a
// window that falls outside a seeded season, which keeps failures loud. Since
// issue #2117 the base seed's seasons are RELATIVE (a broad Winter band from
// ~90 days back to ~240 days out, a ~30-day gap, then a Summer band), so a
// window a few weeks out is always in-season on any run date — see
// SEEDED_SEASONS (prisma/e2e-fixtures.ts) and docs/E2E_PLAYWRIGHT.md.
import {
  IB_WINDOW,
  SEEDED_SEASONS,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_WINDOW,
} from "../../prisma/e2e-fixtures";

const FIRST_WINDOW_OFFSET_DAYS = 21;

// The September fixture windows are FIXED dates while stayWindow Mondays drift
// weekly with the run date, so an index periodically lands ON one of them —
// including the seeded-FULL waitlist window (22 guests), where a spec's
// booking creation is refused outright (#1703; first observed as #1686's
// admin-override collision). Every reserved Monday is skipped for every index,
// so windows stay mutually disjoint AND clear of the fixtures on all run dates.
const RESERVED_WINDOW_CHECKINS = new Set<string>([
  IB_WINDOW.checkIn,
  WAITLIST_FULL_WINDOW.checkIn,
  WAITLIST_OFFER_WINDOW.checkIn,
]);

// Seeded booking seasons (relative; defined in prisma/e2e-fixtures.ts, written
// by prisma/seed.ts): a Winter band and a Summer band with a deliberate ~30-day
// gap between them. A window whose nights fall in that gap (or outside both
// bands) has no season rate, so /api/bookings/quote prices it out-of-season and
// the wizard refuses to advance to review (cf. #1703). Windows must therefore
// land entirely inside one season, on any run date. ISO YYYY-MM-DD sorts
// lexicographically, so plain string comparison is a correct date compare.
// Season key matches the club-config rate columns (config/club.json →
// nightlyRates.winter / .summer) and the seed's WINTER/SUMMER season types.
// The concrete season spans are RELATIVE (issue #2117) and defined ONCE in
// prisma/e2e-fixtures.ts, imported by BOTH this helper and
// e2e/setup/relativize-seasons.ts (which re-dates the base seed's Season rows on
// the E2E DB), so the DB seasons and this classifier can never drift apart.
export type SeededSeasonKey = (typeof SEEDED_SEASONS)[number]["key"];

function isWindowInSeededSeason(nights: string[]): boolean {
  return SEEDED_SEASONS.some((season) =>
    nights.every((night) => night >= season.start && night <= season.end),
  );
}

// Which seeded season a window's nights fall in — winter vs summer selects the
// club-config rate column, so a price assertion stays correct on any run date
// regardless of which season the index lands in (stayWindow may drift a window
// from winter into summer as the run date advances). Throws if the window is not
// wholly inside one seeded season, which stayWindow already guarantees.
export function seasonForWindow(
  window: Pick<StayWindow, "nights">,
): SeededSeasonKey {
  const season = SEEDED_SEASONS.find((s) =>
    window.nights.every((night) => night >= s.start && night <= s.end),
  );
  if (!season) {
    throw new Error(
      `stay window nights ${window.nights.join(", ")} fall outside every seeded ` +
        `season (see SEEDED_SEASONS / prisma/seed.ts).`,
    );
  }
  return season.key;
}

export type StayWindow = {
  checkIn: string; // YYYY-MM-DD (NZ date-only lodge night)
  checkOut: string;
  nights: string[]; // occupied lodge nights: checkIn inclusive, checkOut exclusive
};

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Window n = the (n+1)th usable Monday at least FIRST_WINDOW_OFFSET_DAYS from
// today, staying Mon+Tue nights (checkout Wednesday). A Monday is usable when it
// is neither a reserved fixture check-in nor in a seeded-season gap. Each spec
// uses its own index so bookings never collide on a member-night.
export function stayWindow(index: number): StayWindow {
  const earliest = addDays(new Date(), FIRST_WINDOW_OFFSET_DAYS);
  const daysUntilMonday = (8 - earliest.getDay()) % 7; // getDay(): Monday === 1
  let monday = addDays(earliest, daysUntilMonday);
  let remaining = index;
  // Walk Mondays, skipping reserved fixture check-ins and any window that would
  // fall outside a seeded season (e.g. the October 2026 gap), until the index-th
  // usable one. Bounded by MAX_MONDAYS so a run date past the last seeded season
  // fails loudly (reseed required) instead of looping forever.
  const MAX_MONDAYS = 200;
  for (let step = 0; step < MAX_MONDAYS; step += 1) {
    const nights = [toDateOnly(monday), toDateOnly(addDays(monday, 1))];
    const usable =
      !RESERVED_WINDOW_CHECKINS.has(toDateOnly(monday)) &&
      isWindowInSeededSeason(nights);
    if (usable) {
      if (remaining === 0) {
        const tuesday = addDays(monday, 1);
        const wednesday = addDays(monday, 2);
        return {
          checkIn: toDateOnly(monday),
          checkOut: toDateOnly(wednesday),
          nights,
        };
      }
      remaining -= 1;
    }
    monday = addDays(monday, 7);
  }
  throw new Error(
    `stayWindow(${index}) found no in-season Monday within ${MAX_MONDAYS} weeks ` +
      `of ${toDateOnly(addDays(new Date(), FIRST_WINDOW_OFFSET_DAYS))}. The seeded ` +
      `seasons (see prisma/seed.ts and SEEDED_SEASONS) no longer cover the test ` +
      `horizon for this run date — reseed the booking seasons. See docs/E2E_PLAYWRIGHT.md.`,
  );
}

// aria-label date fragment used by the booking calendar day buttons, e.g.
// "Monday, 17 August 2026".
export function calendarDayLabel(dateOnly: string): RegExp {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("en-NZ", { weekday: "long" });
  const month = date.toLocaleDateString("en-NZ", { month: "long" });
  // Test helper: pattern is built from a formatted test date (weekday/day/month/year), not user input; no ReDoS.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${weekday}, ${d} ${month} ${y},`);
}
