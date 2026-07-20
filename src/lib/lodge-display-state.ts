import type { AgeTier, DisplayNameGranularity } from "@prisma/client";
import {
  getGuestStayEnd,
  getGuestStayStart,
  getLodgeVisibleGuestsForDate,
} from "./booking-guest-stay-ranges";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "./booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
} from "./date-only";
import { getCachedClubIdentity } from "./public-layout-config";
import { CLUB_THEME_ID } from "./club-theme-schema";
import { getSanitizedLodgeInstructions } from "./lodge-instructions";
import { DISPLAY_RELEVANT_MODULE_KEYS } from "./lodge-display/conditions";
import { lodgeNullTolerantScope } from "./lodges";
import { loadEffectiveModuleFlags } from "./module-settings";
import { canServeMemberPhoneOnLodgeSurface, formatXeroPhone } from "./phone";
import type { ModuleKey } from "@/config/modules";
import { prisma } from "./prisma";

// The lobby display's data contract and privacy serialiser (fork issue #28,
// docs/lobby-display/design.md §5 and §10). THIS FILE IS THE SINGLE
// ENFORCEMENT POINT for what a public screen may show: names leave here
// already reduced to the configured granularity, minors are never
// individually named at any level, and no monetary or member-id field is ever
// selected. Every display module renders as a pure function of the DisplayState
// payload — templates cannot reach past it.
//
// The ONE contact exception (#125 / #37) is a member phone number, and it is
// released per-guest ONLY under the two-sided consent gate
// (`canServeMemberPhoneOnLodgeSurface`): the lodge has enabled phone display
// AND the member has opted in AND the guest is an adult AND the row already
// shows individual names. Both config flags default off, so by default no phone
// ever enters the payload.

export const DEFAULT_DISPLAY_NAME_GRANULARITY: DisplayNameGranularity =
  "FIRST_NAME_SURNAME_INITIAL";

export const DISPLAY_WINDOW_DEFAULT_DAYS = 3;
export const DISPLAY_WINDOW_MAX_DAYS = 7;

// A sole-occupancy booking only collapses to the whole-lodge blockout
// treatment when it is a genuine group take-over: an organisation booking, or
// at least this many guests. Keeps a lone mid-week guest off the blockout
// board. Documented in design.md §10; review-flagged on epic #25.
export const WHOLE_LODGE_MIN_GUESTS = 8;

const MINOR_AGE_TIERS: readonly AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

export interface DisplayStateGuest {
  label: string;
  stayStart: string;
  stayEnd: string;
  /** Adult member phone number — present ONLY when the two-sided consent gate
   * allows it (#125 / #37); omitted otherwise, so the default payload carries
   * no contact field. */
  phone?: string;
}

export interface DisplayStateBooking {
  /** Opaque per-row key — never the real booking id. */
  key: string;
  label: string;
  wholeLodge: boolean;
  roomId: string | null;
  /** Null when names are withheld (counts-only, family, org, whole-lodge). */
  guests: DisplayStateGuest[] | null;
  guestCount: number;
  stayStart: string;
  stayEnd: string;
}

export interface DisplayState {
  lodge: { name: string };
  /** Club branding for the header brand block (issue #56): the configured
   * club name and the club-theme logo data URL — presentation-only fields
   * already public on every website page. */
  club: { name: string; logoDataUrl: string | null };
  generatedAt: string;
  window: { start: string; days: number };
  rooms: Array<{ id: string; name: string }> | null;
  bookings: DisplayStateBooking[];
  occupancy: Array<{
    date: string;
    arriving: number;
    departing: number;
    staying: number;
  }>;
  chores: Array<{ date: string; title: string; assigneeLabels: string[] }>;
  rules: Array<{ title: string; html: string }> | null;
  /** Committee notice board content (#36): admin-authored free text,
   * rendered as text nodes only; {{config:<key>}} placeholders resolve
   * inside it at render. */
  notice: string | null;
  config: Record<string, string>;
  /** Display-relevant module flags only (ADR-003 §3): the capability
   * conditions read these instead of querying, so the evaluator stays a pure
   * function of the payload. Limited to DISPLAY_RELEVANT_MODULE_KEYS — the
   * whole club flag map is never shipped to a public wall. */
  capabilities: Record<string, boolean>;
}

function isMinor(ageTier: AgeTier): boolean {
  return MINOR_AGE_TIERS.includes(ageTier);
}

/** Reduce an adult's name to the configured granularity. */
export function reduceName(
  firstName: string,
  lastName: string,
  granularity: DisplayNameGranularity
): string | null {
  const first = firstName.trim();
  const last = lastName.trim();
  switch (granularity) {
    case "FULL_NAME":
      return [first, last].filter(Boolean).join(" ");
    case "FIRST_NAME_SURNAME_INITIAL":
      return last ? `${first} ${last[0].toUpperCase()}` : first;
    case "FIRST_NAME_ONLY":
      return first;
    case "COUNTS_ONLY":
      return null;
  }
}

interface OrganiserShape {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Whether a booking's guests may be individually named anywhere on the wall
 * (design.md §10 settled rules; issue #174): a whole-lodge blockout, any
 * minor in the booking, an organisation organiser, or counts-only
 * granularity all suppress individual names in favour of the booking's
 * reduced group label. This is the SINGLE definition of that condition —
 * every board that might name an individual (booking rows, chore assignees)
 * calls this instead of re-deriving the condition list.
 */
export function namesAllowedForBooking(options: {
  wholeLodge: boolean;
  containsMinors: boolean;
  organiserAgeTier: AgeTier;
  granularity: DisplayNameGranularity;
}): boolean {
  return (
    !options.wholeLodge &&
    !options.containsMinors &&
    options.organiserAgeTier !== "NOT_APPLICABLE" &&
    options.granularity !== "COUNTS_ONLY"
  );
}

/**
 * The booking-level label (design.md §10 settled rules):
 * - organisation organiser (schools, clubs): the organisation's full name at
 *   EVERY granularity — organisations are not people;
 * - booking containing minors: a family/group label, never individual names;
 * - otherwise: the organiser's name at the configured granularity.
 */
export function bookingLabel(
  organiser: OrganiserShape,
  options: {
    granularity: DisplayNameGranularity;
    containsMinors: boolean;
    guestCount: number;
  }
): string {
  const { granularity, containsMinors, guestCount } = options;

  if (organiser.ageTier === "NOT_APPLICABLE") {
    return [organiser.firstName.trim(), organiser.lastName.trim()]
      .filter(Boolean)
      .join(" ");
  }

  if (containsMinors) {
    const last = organiser.lastName.trim();
    if (
      last &&
      (granularity === "FULL_NAME" ||
        granularity === "FIRST_NAME_SURNAME_INITIAL")
    ) {
      return `${last} family`;
    }
    return `Family of ${guestCount}`;
  }

  return (
    reduceName(organiser.firstName, organiser.lastName, granularity) ??
    `Guests · ${guestCount}`
  );
}

/** Sanitise the per-lodge config glob to a flat string map with caps. */
export function sanitiseDisplayConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) continue;
    if (typeof value !== "string") continue;
    // Strip control characters; values are additionally HTML-escaped at
    // render time by the config-token resolver (LTV-006).
    out[key] = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500);
  }
  return out;
}

export function clampDisplayWindowDays(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested)) {
    return DISPLAY_WINDOW_DEFAULT_DAYS;
  }
  return Math.min(DISPLAY_WINDOW_MAX_DAYS, Math.max(1, Math.floor(requested)));
}

/**
 * Build the DisplayState payload for one lodge. `lodgeId` comes from the
 * display device's FK (checkDisplayAuth) — every query below is scoped to it
 * and nothing from any other lodge can appear (issue #28 AC5).
 */
export async function buildDisplayState(
  lodgeId: string,
  options: { days?: number | null; windowStart?: Date | null } = {}
): Promise<DisplayState | null> {
  const days = clampDisplayWindowDays(options.days ?? null);
  // `windowStart` is the admin-preview simulated date (issue #60); it only
  // reaches here from the preview branch of the state route — device fetches
  // never pass it, so a real screen always starts today.
  const startDate = options.windowStart ?? getTodayDateOnly();
  const endExclusive = addDaysDateOnly(startDate, days);
  const endInclusive = addDaysDateOnly(endExclusive, -1);
  const windowDates = eachDateOnlyInRange(startDate, endExclusive).slice(0, days);

  const [lodge, flags] = await Promise.all([
    prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: {
        id: true,
        name: true,
        active: true,
        displayConfig: true,
        displayNameGranularity: true,
        displayNotice: true,
        showGuestPhonesOnScreens: true,
      },
    }),
    loadEffectiveModuleFlags(),
  ]);
  if (!lodge || !lodge.active) return null;

  const granularity =
    lodge.displayNameGranularity ?? DEFAULT_DISPLAY_NAME_GRANULARITY;

  const [bookings, rooms, choreRows, instructionDocs] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: endInclusive },
        checkOut: { gte: startDate },
        ...lodgeNullTolerantScope(lodgeId),
        guests: {
          some: {
            stayStart: { lte: endInclusive },
            stayEnd: { gte: startDate },
          },
        },
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        // Authoritative whole-lodge treatment (#122 / epic #116, ADR-001
        // decision 4): an explicit exclusive hold drives the blockout board,
        // with the sole-occupancy heuristic as the fallback for un-flagged
        // bookings.
        wholeLodgeHold: true,
        member: {
          select: { firstName: true, lastName: true, ageTier: true },
        },
        guests: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
            // #125 / #37: the member's opt-in + phone, released per-guest only
            // under `canServeMemberPhoneOnLodgeSurface` in the row builder.
            member: {
              select: {
                ageTier: true,
                lodgeScreenPhoneOptIn: true,
                phoneCountryCode: true,
                phoneAreaCode: true,
                phoneNumber: true,
              },
            },
            nights: { select: { stayDate: true } },
            bedAllocations: {
              where: {
                stayDate: { gte: startDate, lte: endInclusive },
              },
              orderBy: { stayDate: "asc" },
              select: { roomId: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
    }),
    flags.bedAllocation
      ? prisma.lodgeRoom.findMany({
          where: { active: true, lodgeId },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    flags.chores
      ? prisma.choreAssignment.findMany({
          where: {
            date: { gte: startDate, lt: endExclusive },
            booking: {
              status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
              ...lodgeNullTolerantScope(lodgeId),
            },
          },
          orderBy: [{ date: "asc" }],
          select: {
            date: true,
            choreTemplate: { select: { name: true } },
            bookingGuest: {
              select: { firstName: true, lastName: true, ageTier: true },
            },
            booking: {
              select: {
                // `id` looks the booking up in `wholeLodgeBookingIds` below —
                // the same whole-lodge decision the booking rows use (#174).
                id: true,
                member: {
                  select: { firstName: true, lastName: true, ageTier: true },
                },
                guests: { select: { ageTier: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    getSanitizedLodgeInstructions(lodgeId),
  ]);

  // --- occupancy + per-booking visibility per window day -------------------
  const perBookingDayCounts = new Map<string, Map<string, number>>();
  // NIGHT counts (departure day excluded) drive whole-lodge detection: a
  // group leaving Monday morning still had the lodge to itself even when
  // someone arrives Monday evening (issue #58 — the departure-day overlap
  // used to break the blockout for every back-to-back handover).
  const perBookingNightCounts = new Map<string, Map<string, number>>();
  const nightTotals = new Map<string, number>();
  const occupancy = windowDates.map((date) => {
    const dateKey = formatDateOnly(date);
    let arriving = 0;
    let departing = 0;
    let staying = 0;

    for (const booking of bookings) {
      const visible = getLodgeVisibleGuestsForDate(
        booking.guests,
        date,
        booking,
        { includeDepartureDate: true }
      );
      if (visible.length > 0) {
        let dayMap = perBookingDayCounts.get(booking.id);
        if (!dayMap) {
          dayMap = new Map();
          perBookingDayCounts.set(booking.id, dayMap);
        }
        dayMap.set(dateKey, visible.length);
      }
      const nightGuests = visible.filter(
        (guest) => getGuestStayEnd(guest, booking).getTime() !== date.getTime()
      );
      if (nightGuests.length > 0) {
        let nightMap = perBookingNightCounts.get(booking.id);
        if (!nightMap) {
          nightMap = new Map();
          perBookingNightCounts.set(booking.id, nightMap);
        }
        nightMap.set(dateKey, nightGuests.length);
        nightTotals.set(dateKey, (nightTotals.get(dateKey) ?? 0) + nightGuests.length);
      }
      staying += visible.length;
      arriving += visible.filter(
        (guest) => getGuestStayStart(guest, booking).getTime() === date.getTime()
      ).length;
      departing += visible.filter(
        (guest) => getGuestStayEnd(guest, booking).getTime() === date.getTime()
      ).length;
    }

    return { date: dateKey, arriving, departing, staying };
  });

  // --- whole-lodge detection: an explicit exclusive hold is AUTHORITATIVE
  // (#122 / epic #116, ADR-001 decision 4) — a flagged booking always gets the
  // blockout treatment regardless of headcount. The sole-occupancy heuristic
  // (design.md §10: sole occupancy on every NIGHT the booking covers AND a
  // genuine group — organisation or >= threshold) is the fallback for
  // un-flagged bookings.
  const wholeLodgeBookingIds = new Set<string>();
  for (const booking of bookings) {
    if (booking.wholeLodgeHold) {
      wholeLodgeBookingIds.add(booking.id);
      continue;
    }
    const nightMap = perBookingNightCounts.get(booking.id);
    if (!nightMap || nightMap.size === 0) continue;
    const isSoleOnAllNights = [...nightMap.entries()].every(
      ([dateKey, count]) => nightTotals.get(dateKey) === count
    );
    const guestCount = booking.guests.length;
    const isOrganisation = booking.member.ageTier === "NOT_APPLICABLE";
    if (isSoleOnAllNights && (isOrganisation || guestCount >= WHOLE_LODGE_MIN_GUESTS)) {
      wholeLodgeBookingIds.add(booking.id);
    }
  }

  // --- booking rows: split per (booking, room); privacy-reduce labels ------
  const rows: DisplayStateBooking[] = [];
  for (const booking of bookings) {
    if (!perBookingDayCounts.has(booking.id)) continue; // nothing visible in window

    const containsMinors = booking.guests.some((guest) => isMinor(guest.ageTier));
    const wholeLodge = wholeLodgeBookingIds.has(booking.id);
    const label = bookingLabel(booking.member, {
      granularity,
      containsMinors,
      guestCount: booking.guests.length,
    });
    // Individual names appear only when every privacy condition allows it.
    const namesAllowed = namesAllowedForBooking({
      wholeLodge,
      containsMinors,
      organiserAgeTier: booking.member.ageTier,
      granularity,
    });

    const byRoom = new Map<string | null, typeof booking.guests>();
    for (const guest of booking.guests) {
      const inWindow =
        getGuestStayStart(guest, booking).getTime() <= endInclusive.getTime() &&
        getGuestStayEnd(guest, booking).getTime() >= startDate.getTime();
      if (!inWindow) continue;
      const roomId =
        rooms === null ? null : guest.bedAllocations[0]?.roomId ?? null;
      const group = byRoom.get(roomId) ?? [];
      group.push(guest);
      byRoom.set(roomId, group);
    }

    let rowIndex = 0;
    for (const [roomId, guests] of byRoom) {
      const stayStarts = guests.map((g) => getGuestStayStart(g, booking).getTime());
      const stayEnds = guests.map((g) => getGuestStayEnd(g, booking).getTime());
      rows.push({
        key: `row-${rows.length + 1}-${rowIndex++}`,
        label,
        wholeLodge,
        roomId,
        guests: namesAllowed
          ? guests.map((guest) => {
              // Phone rides the same row that already shows an individual name.
              // The member's own age tier decides adulthood (falls back to the
              // guest tier for a non-member guest, who has no opt-in and so is
              // filtered out anyway).
              const phone =
                guest.member &&
                canServeMemberPhoneOnLodgeSurface({
                  lodgeShowGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
                  memberOptedIn: guest.member.lodgeScreenPhoneOptIn,
                  ageTier: guest.member.ageTier ?? guest.ageTier,
                })
                  ? formatXeroPhone(guest.member)
                  : null;
              return {
                label:
                  reduceName(guest.firstName, guest.lastName, granularity) ?? "",
                stayStart: formatDateOnly(getGuestStayStart(guest, booking)),
                stayEnd: formatDateOnly(getGuestStayEnd(guest, booking)),
                ...(phone ? { phone } : {}),
              };
            })
          : null,
        guestCount: guests.length,
        stayStart: formatDateOnly(new Date(Math.min(...stayStarts))),
        stayEnd: formatDateOnly(new Date(Math.max(...stayEnds))),
      });
    }
  }

  // --- chores: assignee labels obey the SAME namesAllowed decision as the
  // booking rows (#174) — a chore assignee is never named more precisely
  // than that booking's own row on the wall.
  const chores = choreRows.map((assignment) => {
    const assignee = assignment.bookingGuest;
    let assigneeLabels: string[] = [];
    if (assignee) {
      const bookingContainsMinors = assignment.booking.guests.some((guest) =>
        isMinor(guest.ageTier)
      );
      const namesAllowed = namesAllowedForBooking({
        wholeLodge: wholeLodgeBookingIds.has(assignment.booking.id),
        containsMinors: bookingContainsMinors,
        organiserAgeTier: assignment.booking.member.ageTier,
        granularity,
      });
      if (namesAllowed) {
        const label = reduceName(
          assignee.firstName,
          assignee.lastName,
          granularity
        );
        assigneeLabels = label ? [label] : [];
      } else {
        // Names are withheld for this booking (minor present, whole-lodge,
        // organisation organiser, or counts-only): fall back to the
        // booking's reduced group label rather than the assignee's name.
        assigneeLabels = [
          bookingLabel(assignment.booking.member, {
            granularity,
            containsMinors: bookingContainsMinors,
            guestCount: assignment.booking.guests.length,
          }),
        ];
      }
    }
    return {
      date: formatDateOnly(assignment.date),
      title: assignment.choreTemplate.name,
      assigneeLabels,
    };
  });

  // Only the display-relevant module flags reach the public payload — never
  // the whole club flag map (ADR-003 §3). The capability conditions read these.
  const capabilities: Record<string, boolean> = Object.fromEntries(
    (Object.keys(DISPLAY_RELEVANT_MODULE_KEYS) as ModuleKey[]).map((key) => [
      key,
      Boolean(flags[key]),
    ])
  );

  // Club branding is best-effort: a missing theme row must never take the
  // board down, so failures degrade to a text-only brand block.
  const theme = await prisma.clubTheme
    .findUnique({ where: { id: CLUB_THEME_ID }, select: { logoDataUrl: true } })
    .catch(() => null);

  // DB-first club name (E3 #1929, leak fixed C5 #1984): resolve through
  // ClubIdentitySettings so an admin rename reaches the lobby display, instead of
  // reading the raw config/club.json name. Uses the tagged 15s cache (invalidated
  // by the admin identity PUT via invalidatePublicClubIdentity) rather than an
  // uncached read, because /api/display/state is polled. Never throws — falls
  // back to config.
  const clubIdentity = await getCachedClubIdentity();

  return {
    lodge: { name: lodge.name },
    club: { name: clubIdentity.name, logoDataUrl: theme?.logoDataUrl ?? null },
    generatedAt: new Date().toISOString(),
    window: { start: formatDateOnly(startDate), days },
    rooms,
    bookings: rows,
    occupancy,
    chores,
    rules:
      instructionDocs.length > 0
        ? instructionDocs.map((doc) => ({
            title: doc.title,
            html: doc.contentHtml,
          }))
        : null,
    notice:
      lodge.displayNotice && lodge.displayNotice.trim().length > 0
        ? lodge.displayNotice.trim().slice(0, 2000)
        : null,
    config: sanitiseDisplayConfig(lodge.displayConfig),
    capabilities,
  };
}
