import { prisma } from "./prisma";
import { capacityHoldingBookingFilter } from "@/lib/booking-status";
import {
  getLodgeCapacity,
  getLodgePartnerSharedCapacityStatus,
} from "@/lib/lodge-capacity";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export { getLodgeCapacity } from "@/lib/lodge-capacity";

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
  // True when a capacity-holding booking overlapping this night holds the
  // whole lodge exclusively (ADR-001, issue #118). A held night is hard-blocked:
  // availableBeds is pinned to 0 (never negative, so it stays OUT of the
  // over-capacity confirm set) and `available` is forced false. To members it is
  // indistinguishable from a genuinely full lodge (decision 6); an admin
  // over-capacity override cannot punch into it (decision 5).
  wholeLodgeHeld?: boolean;
}

// The admin-override over-capacity error/helpers (issue #1668) live in
// @/lib/over-capacity-confirmation, NOT here: many test files blanket-mock
// this module, and the routes' instanceof checks need the real class.

// Capacity queries scope to one lodge with a plain `lodgeId` field alongside
// the capacity-holding filter: Booking.lodgeId is NOT NULL (no null-lodge rows
// to tolerate), so the per-lodge match is exact.

/**
 * Serialize capacity-mutating booking transactions for one lodge. Replaces
 * the historical club-wide pg_advisory_xact_lock(1): bookings at different
 * lodges no longer contend. hashtextextended gives a stable per-lodge bigint
 * key; a cross-lodge hash collision only causes unnecessary serialization,
 * never a correctness problem. The lock releases at transaction end.
 *
 * $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the
 * driver adapter cannot deserialize as a result row — $queryRaw here fails
 * at runtime on every booking transaction (found in browser verification;
 * every other advisory lock in the codebase already uses $executeRaw).
 */
export async function acquireLodgeCapacityLock(
  tx: Pick<TransactionClient, "$executeRaw">,
  lodgeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lodgeId}, 0))`;
}

function getMonthStartDateOnly(year: number, month: number): Date {
  const date = parseDateOnly(
    `${year}-${String(month + 1).padStart(2, "0")}-01`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month for availability: ${year}-${month + 1}`);
  }

  return date;
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

type OccupancyBooking = {
  checkIn?: Date | null;
  checkOut?: Date | null;
  guests?: GuestStayRange[] | null;
};

type OccupancyIndexEntry = {
  booking: OccupancyBooking;
  checkIn: Date;
  checkOut: Date;
  checkInKey: string;
  checkOutKey: string;
};

/**
 * Precompute each booking's date-only keys once (#1146). The occupancy loops
 * evaluate every (night, booking) pair, so formatting the booking range per
 * pair made month availability and capacity checks O(nights x bookings)
 * timezone conversions; the index makes each pair a string comparison.
 */
function buildOccupancyIndex(bookings: OccupancyBooking[]): OccupancyIndexEntry[] {
  const index: OccupancyIndexEntry[] = [];
  for (const booking of bookings) {
    if (!booking.checkIn || !booking.checkOut) {
      continue;
    }
    index.push({
      booking,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      checkInKey: formatDateOnlyForTimeZone(booking.checkIn),
      checkOutKey: formatDateOnlyForTimeZone(booking.checkOut),
    });
  }
  return index;
}

function getOccupiedBedsForNightFromIndex(
  night: Date,
  index: OccupancyIndexEntry[]
): number {
  const nightKey = formatDateOnly(night);
  let occupiedBeds = 0;

  for (const entry of index) {
    if (nightKey >= entry.checkInKey && nightKey < entry.checkOutKey) {
      occupiedBeds += countActiveGuestsForNight(entry.booking.guests, night, {
        checkIn: entry.checkIn,
        checkOut: entry.checkOut,
      });
    }
  }

  return occupiedBeds;
}

export function getOccupiedBedsForNight(
  night: Date,
  bookings: OccupancyBooking[]
): number {
  return getOccupiedBedsForNightFromIndex(night, buildOccupancyIndex(bookings));
}

type WholeLodgeHoldBooking = {
  checkIn?: Date | null;
  checkOut?: Date | null;
  wholeLodgeHold?: boolean | null;
};

type WholeLodgeHoldEntry = { checkInKey: string; checkOutKey: string };

/**
 * Precompute the date-only spans of the overlapping bookings that hold the
 * whole lodge exclusively (ADR-001, issue #118). A booking holds a night when
 * `checkIn <= night < checkOut` — the [checkIn, checkOut) half-open span, so a
 * held booking departing on day D does NOT block another booking arriving that
 * night (back-to-back handovers stay correct).
 */
function buildWholeLodgeHoldIndex(
  bookings: WholeLodgeHoldBooking[]
): WholeLodgeHoldEntry[] {
  const index: WholeLodgeHoldEntry[] = [];
  for (const booking of bookings) {
    if (!booking.wholeLodgeHold || !booking.checkIn || !booking.checkOut) {
      continue;
    }
    index.push({
      checkInKey: formatDateOnlyForTimeZone(booking.checkIn),
      checkOutKey: formatDateOnlyForTimeZone(booking.checkOut),
    });
  }
  return index;
}

function isNightWholeLodgeHeld(
  night: Date,
  index: WholeLodgeHoldEntry[]
): boolean {
  if (index.length === 0) return false;
  const nightKey = formatDateOnly(night);
  return index.some(
    (entry) => nightKey >= entry.checkInKey && nightKey < entry.checkOutKey
  );
}

/**
 * Two bookings overlap on at least one night when their [checkIn, checkOut)
 * half-open spans intersect. A booking departing on day D and one arriving that
 * night do NOT overlap (back-to-back handovers) — the same half-open rule the
 * hold-night span uses. Pure; admin conflict surfacing (issue #119) shares it.
 */
export function bookingsOverlap(
  a: { checkIn: Date; checkOut: Date },
  b: { checkIn: Date; checkOut: Date }
): boolean {
  return (
    a.checkIn.getTime() < b.checkOut.getTime() &&
    a.checkOut.getTime() > b.checkIn.getTime()
  );
}

/**
 * Lodge equality tolerant of the expand-release null lodgeId (a null on either
 * side matches, mirroring lodgeNullTolerantScope). Used by admin conflict
 * surfacing (issue #119) when matching a hold to an overlapping booking
 * in-memory.
 */
export function sameLodgeNullTolerant(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return a == null || b == null || a === b;
}

export interface HoldConflictBooking {
  id: string;
  memberName: string;
  /** YYYY-MM-DD (date-only lodge nights). */
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
}

/**
 * Admin conflict surfacing (ADR-001 decision 1, issue #119): the existing
 * capacity-holding bookings that overlap [checkIn, checkOut) at `lodgeId`,
 * excluding `excludeBookingId` (the booking receiving the hold). Reuses the
 * capacity-holding population filter (`capacityHoldingBookingFilter`) and the
 * same overlap window as the capacity engine, rather than inventing a new one.
 *
 * Read-only and purely INFORMATIONAL: setting/approving a hold never refuses,
 * blocks, or displaces (decision 1) — this only makes the clash obvious to the
 * booking officer, who resolves it manually. It is called ONLY from admin paths;
 * members are never told a lodge is exclusively held (decision 6).
 */
export async function findOverlappingCapacityHoldingBookings(
  db: Pick<TransactionClient, "booking">,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    excludeBookingId?: string;
  }
): Promise<HoldConflictBooking[]> {
  const start = normalizeDateOnlyForTimeZone(input.checkIn);
  const end = normalizeDateOnlyForTimeZone(input.checkOut);
  const rows = await db.booking.findMany({
    where: {
      checkIn: { lt: end },
      checkOut: { gt: start },
      deletedAt: null,
      // Capacity-holding population (issue #1254) spread at top level; the
      // exact per-lodge scope + date/exclusion clauses compose under it.
      ...capacityHoldingBookingFilter(),
      lodgeId: input.lodgeId,
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
      member: { select: { firstName: true, lastName: true, email: true } },
      _count: { select: { guests: true } },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    memberName:
      [row.member?.firstName, row.member?.lastName].filter(Boolean).join(" ") ||
      row.member?.email ||
      "Unknown member",
    checkIn: formatDateOnly(row.checkIn),
    checkOut: formatDateOnly(row.checkOut),
    guestCount: row._count.guests,
    status: row.status,
  }));
}

/**
 * Admin capacity-reporting companion to `getLodgeCapacityStatus`
 * (src/lib/lodge-capacity.ts, issue #119): which nights in [checkIn, checkOut)
 * at `lodgeId` are whole-lodge-held by a capacity-holding booking (ADR-001).
 * Lives here — not in lodge-capacity.ts — so it reuses the capacity engine's
 * own hold-night span logic (`buildWholeLodgeHoldIndex` / `isNightWholeLodgeHeld`)
 * rather than duplicating it; getLodgeCapacityStatus takes no date range, so a
 * companion is the additive, backward-compatible way to report held nights.
 *
 * Admin-only reporting: members never see held nights (decision 6 — to them a
 * held night is an ordinary full lodge).
 */
export async function getLodgeHeldNights(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  tx?: TransactionClient
): Promise<string[]> {
  const db = tx ?? prisma;
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const end = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, end);
  if (nights.length === 0) return [];

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: end },
      checkOut: { gt: start },
      wholeLodgeHold: true,
      // Only a capacity-holding hold blocks (a cancelled/expired hold does not),
      // matching the capacity engine's overlap population exactly.
      ...capacityHoldingBookingFilter(),
      lodgeId,
    },
    select: { checkIn: true, checkOut: true, wholeLodgeHold: true },
  });

  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  return nights
    .filter((night) => isNightWholeLodgeHeld(night, holdIndex))
    .map(formatDateOnly);
}

/**
 * Check if there's enough capacity for a given number of guests across all nights.
 */
export async function checkCapacity(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      // Capacity-holding population (issue #1254) spread at top level; the
      // per-lodge scope (also an OR fragment) goes under AND so the two OR
      // conditions compose — a second top-level OR would clobber the first.
      ...capacityHoldingBookingFilter(),
      lodgeId,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNightFromIndex(night, occupancyIndex);
    const wholeLodgeHeld = isNightWholeLodgeHeld(night, holdIndex);

    return {
      date: night,
      occupiedBeds,
      // A held night is hard-blocked at 0 — never negative, so it stays out of
      // the over-capacity confirm set and cannot be bypassed by an admin
      // override (ADR-001 decision 5, issue #118).
      availableBeds: wholeLodgeHeld ? 0 : lodgeCapacity - occupiedBeds,
      wholeLodgeHeld,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));
  const hasHeld = nightDetails.some((n) => n.wholeLodgeHeld);

  return {
    // A held night presents exactly as a full lodge (decision 6): unavailable
    // regardless of the numeric bed count.
    available: minAvailable >= guestCount && !hasHeld,
    minAvailable,
    nightDetails,
  };
}

export async function checkCapacityForGuestRanges(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guests: GuestStayRange[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  if (nights.length === 0) {
    return { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  }

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      // Capacity-holding population (issue #1254) spread at top level; the
      // per-lodge scope (also an OR fragment) goes under AND so the two OR
      // conditions compose — a second top-level OR would clobber the first.
      ...capacityHoldingBookingFilter(),
      lodgeId,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNightFromIndex(night, occupancyIndex);
    const proposedBeds = countActiveGuestsForNight(guests, night, {
      checkIn: start,
      checkOut: exclusiveEnd,
    });
    const wholeLodgeHeld = isNightWholeLodgeHeld(night, holdIndex);

    return {
      date: night,
      occupiedBeds: occupiedBeds + proposedBeds,
      // A held night is hard-blocked at 0 — never negative, so it stays out of
      // the over-capacity confirm set (overCapacityNights) and cannot be
      // bypassed by an admin override (ADR-001 decision 5, issue #118).
      availableBeds: wholeLodgeHeld ? 0 : lodgeCapacity - occupiedBeds - proposedBeds,
      wholeLodgeHeld,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));
  const hasHeld = nightDetails.some((n) => n.wholeLodgeHeld);

  return {
    // A held night presents exactly as a full lodge (decision 6): unavailable
    // even when the numeric bed arithmetic would fit.
    available: minAvailable >= 0 && !hasHeld,
    minAvailable,
    nightDetails,
  };
}

// A proposed non-sharing guest. `memberId` (when the guest is a member) lets
// a sharer's partner coverage be anchored to a guest in this same proposal —
// the sharer-joins-the-partner's-own-booking case, where excludeBookingId
// removes the partner's existing row from the occupancy query.
export interface PartnerSharedProposedGuest extends GuestStayRange {
  memberId?: string | null;
}

export interface PartnerSharedAdmissionSharer {
  range: GuestStayRange;
  memberId: string;
  partnerMemberId: string;
}

export interface PartnerSharedNightDetail extends NightAvailability {
  sharedSlotsUsed: number;
  sharedSlotsNeeded: number;
}

export interface PartnerSharedAdmissionResult {
  available: boolean;
  reason: string | null;
  minAvailable: number;
  partnerSharedHeadroom: number;
  nightDetails: PartnerSharedNightDetail[];
}

/**
 * Admission check for admin-initiated partner-shared bookings (#1745).
 *
 * The base lodge ceiling (`getLodgeCapacity`) is untouched — public booking
 * paths keep calling checkCapacityForGuestRanges and never see the extra
 * slots. This variant admits `sharers` beyond that ceiling, one per active
 * DOUBLE bed (the partner-shared headroom, see docs/CAPACITY_MODEL.md),
 * under the owner-decided rule (#1745): a guest is admitted if a base slot
 * is free, OR they hold a CONFIRMED partner link with a member staying on
 * every night they stay AND a shared slot is free that night.
 * `ordinaryGuests` can never consume a shared slot — the headroom is
 * reserved, not a blanket bump.
 *
 * Placeability: each shared admission maps to a distinct double ONLY when
 * the sharer's partner holds an ordinary (base-backed) place. The guards
 * below enforce the structural half of that — a sharer can never anchor
 * another sharer, and same-proposal coverage must come from a non-sharing
 * proposed guest — but a partner admitted above base through the #1668
 * over-capacity override can still anchor a sharer; both are explicit admin
 * overrides and the combination can exceed pairing feasibility (see
 * docs/CAPACITY_MODEL.md). Placement itself stays the allocation board's
 * job and may require moving unlocked allocations.
 *
 * Callers run inside the lodge capacity lock like every other admission
 * path (acquireLodgeCapacityLock) so shared slots cannot be double-admitted
 * concurrently.
 */
export async function checkCapacityForPartnerSharedAdmission(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  ordinaryGuests: PartnerSharedProposedGuest[],
  sharers: PartnerSharedAdmissionSharer[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<PartnerSharedAdmissionResult> {
  const db = tx ?? prisma;
  const status = await getLodgePartnerSharedCapacityStatus(lodgeId, db);
  const baseCapacity = status.capacity;
  const headroom = status.partnerSharedHeadroom;

  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);
  const envelope = { checkIn: start, checkOut: exclusiveEnd };

  if (nights.length === 0) {
    return {
      available: true,
      reason: null,
      minAvailable: Number.POSITIVE_INFINITY,
      partnerSharedHeadroom: headroom,
      nightDetails: [],
    };
  }

  function rejected(reason: string): PartnerSharedAdmissionResult {
    return {
      available: false,
      reason,
      minAvailable: 0,
      partnerSharedHeadroom: headroom,
      nightDetails: [],
    };
  }

  // Structural placeability guards: a shared slot pairs the sharer with a
  // base-backed partner, so a sharer can never anchor another sharer — a
  // couple must be encoded as one ordinary guest (or existing booking) plus
  // one sharer, never as two sharers. Duplicates would let one person
  // consume two slots.
  const sharerIds = new Set<string>();
  for (const sharer of sharers) {
    if (sharerIds.has(sharer.memberId)) {
      return rejected(
        "The same guest was proposed as a partner-sharer more than once."
      );
    }
    sharerIds.add(sharer.memberId);
  }
  for (const sharer of sharers) {
    if (sharerIds.has(sharer.partnerMemberId)) {
      return rejected(
        "Both members of a couple were proposed as partner-sharers. The partner must hold an ordinary place; only the second occupant is a sharer."
      );
    }
  }

  // Every sharer pair must be eligible outright — an ineligible "sharer" must
  // not silently fall back to an ordinary slot the admin did not intend.
  for (const sharer of sharers) {
    const eligible = await mayShareDoubleBed(
      sharer.memberId,
      sharer.partnerMemberId,
      db
    );
    if (!eligible) {
      return rejected(
        "The guest and their partner do not hold a confirmed partner relationship (or are not both active adults)."
      );
    }
  }

  // Partner night coverage: a shared slot exists only on nights the partner
  // is themselves staying. Coverage comes from a non-sharing guest in this
  // same proposal carrying the partner's memberId (the sharer-joins-the-
  // partner's-own-booking case, where excludeBookingId removes the partner's
  // existing row from occupancy), or from the partner's other capacity-
  // holding bookings at this lodge. Never from an unverified caller claim.
  const coverageBySharer: Array<Set<string>> = [];
  for (const sharer of sharers) {
    const covered = new Set<string>();
    const proposedPartnerRows = ordinaryGuests.filter(
      (guest) => guest.memberId === sharer.partnerMemberId
    );
    for (const night of nights) {
      if (
        proposedPartnerRows.length > 0 &&
        countActiveGuestsForNight(proposedPartnerRows, night, envelope) > 0
      ) {
        covered.add(formatDateOnly(night));
      }
    }

    // Only hit the database for nights the proposal itself does not cover.
    const sharerNightsUncovered = nights.some(
      (night) =>
        countActiveGuestsForNight([sharer.range], night, envelope) > 0 &&
        !covered.has(formatDateOnly(night))
    );
    if (sharerNightsUncovered) {
      const partnerGuests = await db.bookingGuest.findMany({
        where: {
          memberId: sharer.partnerMemberId,
          booking: {
            lodgeId,
            checkIn: { lt: exclusiveEnd },
            checkOut: { gt: start },
            // Nested under AND so the holding filter's top-level OR composes
            // with the scope fields (same pitfall as the occupancy queries).
            AND: [capacityHoldingBookingFilter()],
            ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
          },
        },
        include: {
          nights: true,
          booking: { select: { checkIn: true, checkOut: true } },
        },
      });
      const guestEnvelopes = partnerGuests.map((guest) => ({
        guest,
        checkInKey: formatDateOnlyForTimeZone(guest.booking.checkIn),
        checkOutKey: formatDateOnlyForTimeZone(guest.booking.checkOut),
      }));
      for (const night of nights) {
        const nightKey = formatDateOnly(night);
        if (covered.has(nightKey)) continue;
        // Gate on the booking envelope exactly like the occupancy index does,
        // so a stray night row outside its booking window can never grant
        // coverage occupancy would not count.
        const present = guestEnvelopes.some(
          (entry) =>
            nightKey >= entry.checkInKey &&
            nightKey < entry.checkOutKey &&
            countActiveGuestsForNight([entry.guest], night, {
              checkIn: entry.guest.booking.checkIn,
              checkOut: entry.guest.booking.checkOut,
            }) > 0
        );
        if (present) covered.add(nightKey);
      }
    }
    coverageBySharer.push(covered);
  }

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      ...capacityHoldingBookingFilter(),
      lodgeId,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: {
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  let reason: string | null = null;
  const nightDetails: PartnerSharedNightDetail[] = nights.map((night) => {
    const nightKey = formatDateOnly(night);
    const occupied = getOccupiedBedsForNightFromIndex(night, occupancyIndex);
    const ordinary = countActiveGuestsForNight(ordinaryGuests, night, envelope);
    const wholeLodgeHeld = isNightWholeLodgeHeld(night, holdIndex);
    if (wholeLodgeHeld) {
      // A whole-lodge hold (ADR-001, issue #118) hard-blocks this night even for
      // the admin-initiated partner-shared admission path — decision 5: a hold is
      // not bypassable by any admin override. Pinned to availableBeds 0 (never
      // negative) and surfaced via `reason`.
      reason ??=
        "The lodge is exclusively held for another booking for part of the requested stay.";
    }

    let sharersPresent = 0;
    for (const [index, sharer] of sharers.entries()) {
      if (countActiveGuestsForNight([sharer.range], night, envelope) === 0) {
        continue;
      }
      if (!coverageBySharer[index].has(nightKey)) {
        // A shared slot exists only on nights the partner also stays.
        reason ??=
          "The partner is not staying on every night requested for the shared guest.";
        continue;
      }
      sharersPresent += 1;
    }

    // Any existing occupancy above the base ceiling counts as consumed shared
    // slots. Usually that IS prior shared admissions, but a #1668 forced
    // overbook also lands here — deliberately conservative: forced overage
    // shrinks what sharers may add (it can only mislabel the reason, never
    // overbook further).
    const baseUsed = Math.min(occupied, baseCapacity);
    const sharedUsed = occupied - baseUsed;

    // Ordinary guests fit under the base ceiling only — the shared slots are
    // reserved for partner-sharers.
    const baseFreeAfterOrdinary = baseCapacity - baseUsed - ordinary;
    if (baseFreeAfterOrdinary < 0) {
      reason ??= "The lodge is fully booked for part of the requested stay.";
    }

    // Sharers take a free base slot first (anyone may, below the ceiling);
    // the remainder need shared slots.
    const sharedNeeded = Math.max(
      0,
      sharersPresent - Math.max(0, baseFreeAfterOrdinary)
    );
    if (sharedUsed + sharedNeeded > headroom) {
      reason ??=
        headroom === 0
          ? "This lodge has no shareable double beds (or its capacity setting leaves no partner headroom)."
          : "All partner-shared double-bed slots are taken for part of the requested stay.";
    }

    const totalProposed = ordinary + sharersPresent;
    return {
      date: night,
      occupiedBeds: occupied + totalProposed,
      availableBeds: wholeLodgeHeld
        ? 0
        : baseCapacity + headroom - occupied - totalProposed,
      sharedSlotsUsed: sharedUsed,
      sharedSlotsNeeded: sharedNeeded,
      wholeLodgeHeld,
    };
  });

  // A sharer whose range covers a night the partner does not was counted out
  // of sharersPresent above; surface it as unavailable even if the arithmetic
  // happened to pass.
  const available = reason === null;
  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available,
    reason,
    minAvailable,
    partnerSharedHeadroom: headroom,
    nightDetails,
  };
}

/**
 * Get a monthly availability summary for calendar display at one lodge.
 */
export async function getMonthAvailability(
  lodgeId: string,
  year: number,
  month: number
): Promise<Map<string, number>> {
  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);
  const lodgeCapacity = await getLodgeCapacity(lodgeId);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      // Capacity-holding population (issue #1254) spread at top level; the
      // per-lodge scope (also an OR fragment) goes under AND so the two compose.
      ...capacityHoldingBookingFilter(),
      lodgeId,
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const availability = new Map<string, number>();
  const nights = eachDateOnlyInRange(startDate, endDate);
  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);

  for (const night of nights) {
    // A whole-lodge-held night (ADR-001, issue #118) must be indistinguishable
    // from a genuinely full lodge on the public calendar (decision 6): report
    // full occupancy so no free beds are ever shown, regardless of the real
    // headcount on that night. Otherwise a held-but-not-full night would leak
    // the hold — a member could tell it apart from a full lodge.
    const occupiedBeds = isNightWholeLodgeHeld(night, holdIndex)
      ? lodgeCapacity
      : getOccupiedBedsForNightFromIndex(night, occupancyIndex);

    const key = formatDateOnly(night);
    availability.set(key, occupiedBeds);
  }

  return availability;
}
