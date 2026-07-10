import type { AgeTier } from "@prisma/client";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

type BedAllocationSource = "AUTO" | "MANUAL";
// Matches the DB enum so freshly-read guest rows type-check. Guests are
// people, so NOT_APPLICABLE (the organisation tier, #1440) cannot enter
// through validated inputs; if legacy data ever carries it, the guest is
// simply grouped as a non-adult by isAdultAgeTier.
export type BedAllocationAgeTier = AgeTier;

interface BedAllocationBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder?: number | null;
  active?: boolean | null;
}

export interface BedAllocationRoom {
  id: string;
  name: string;
  sortOrder?: number | null;
  active?: boolean | null;
  // The lodge this room belongs to. A null lodgeId during the expand release
  // (rooms written before the backfill, or by a draining old colour) is
  // treated as club-wide-compatible. Used by roomsForBooking so a booking's
  // guests can never land in another lodge's beds, even when the caller pools
  // multiple lodges' rooms (club-wide auto-allocation).
  lodgeId?: string | null;
  beds: BedAllocationBed[];
}

interface BedAllocationGuest {
  id: string;
  bookingId: string;
  stayStart: Date;
  stayEnd: Date;
  ageTier?: BedAllocationAgeTier | null;
}

export interface BedAllocationBooking {
  id: string;
  createdAt: Date;
  // The lodge this booking belongs to (ADR-001: one booking = one lodge). Null
  // during the expand release stays club-wide-compatible. roomsForBooking uses
  // it to restrict the booking to its own lodge's rooms.
  lodgeId?: string | null;
  guests: BedAllocationGuest[];
  /**
   * Preferred room from the booking's room request, if any. Auto-allocation
   * tries this room first before falling back to family-grouping and
   * first-fit. A missing/inactive room (filtered out of `activeRooms`) is
   * treated as no preference — never an error.
   */
  requestedRoomId: string | null;
  /**
   * Whether this booking holds lodge capacity (issue #1387). Only meaningful
   * when `prioritizeCapacityHolding` is set: capacity-holding bookings are
   * allocated FIRST and may displace a provisional occupant to claim a bed;
   * provisional bookings never displace anyone. Undefined is treated as
   * non-holding, preserving the pure first-fit order for callers that do not
   * classify bookings.
   */
  holdsCapacity?: boolean;
}

interface OccupiedBedNight {
  bedId: string;
  stayDate: string | Date;
  bookingId?: string | null;
  bookingGuestId?: string | null;
  roomId?: string | null;
  ageTier?: BedAllocationAgeTier | null;
  /**
   * Whether the occupying booking holds lodge capacity (issue #1387). Only
   * consulted when `prioritizeCapacityHolding` is set. A capacity-holding
   * occupant (true) is NEVER displaced; a provisional occupant (false) may be
   * moved aside or unallocated to make room for a capacity-holding booking.
   * Undefined is treated as non-displaceable (conservative), so a caller that
   * does not classify occupants can never trigger a displacement.
   */
  holdsCapacity?: boolean;
  /**
   * When set, this allocation was explicitly APPROVED by an admin (the #776
   * bed-lock). An approved allocation is NEVER displaced (issue #1387) — moving
   * or unallocating it would silently undo an admin lock with no human step —
   * and, because displacement now operates on WHOLE provisional stays (issue
   * #1677), one approved night pins the occupying booking's entire stay.
   */
  approvedAt?: Date | string | null;
  /**
   * createdAt of the occupying booking (issue #1677). Used to pick the
   * displacement order when a capacity-holding booking must evict provisional
   * stays from a room: newest provisional bookings are evicted first. Optional;
   * a missing value sorts as oldest, so unclassified occupants are evicted
   * last.
   */
  bookingCreatedAt?: Date | string | null;
  /**
   * True when the occupying booking's stay extends beyond the window the
   * caller loaded (issue #1677). Displacement moves or unallocates a
   * provisional booking's ENTIRE stay; a stay that is only partially visible
   * cannot be moved whole, so it is treated as non-displaceable — mirroring
   * the conservative `holdsCapacity: undefined → non-displaceable` default.
   */
  stayExtendsBeyondWindow?: boolean;
}

type BedAllocationDisplacementType = "MOVE" | "UNALLOCATE";

/**
 * A provisional bed-night that auto-allocation displaced so a capacity-holding
 * booking could claim the bed (issue #1387). `MOVE` relocates the provisional
 * allocation to a still-free bed (`toBedId`/`toRoomId`); `UNALLOCATE` removes
 * it entirely, returning the guest-night to the awaiting-allocation queue. The
 * lifecycle applies these (update / delete) BEFORE creating the new
 * capacity-holding allocations so no transient `@@unique([bedId, stayDate])`
 * conflict occurs, and writes an audit row for each.
 *
 * Since issue #1677 the displacement UNIT is a provisional booking's whole
 * stay: within one plan a displaced booking's records are either all MOVEs
 * into ONE destination room or all UNALLOCATEs — a provisional stay is never
 * night-split, and MOVE/UNALLOCATE are never mixed for one booking.
 */
export interface BedAllocationDisplacement {
  type: BedAllocationDisplacementType;
  /** The displaced PROVISIONAL booking / guest-night (identifies the row). */
  bookingId: string;
  bookingGuestId: string;
  stayDate: string;
  /** The bed the provisional occupant originally held (for the audit trail). */
  fromBedId: string;
  fromRoomId: string;
  /** Destination bed for a MOVE; absent for UNALLOCATE. */
  toBedId?: string;
  toRoomId?: string;
  /** The capacity-holding booking that claimed the freed bed (audit trail). */
  displacedByBookingId: string;
}

export interface BedAllocationCandidate {
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  bedId: string;
  stayDate: string;
  source: BedAllocationSource;
}

export interface UnallocatedGuestNight {
  bookingId: string;
  bookingGuestId: string;
  stayDate: string;
  reason: "NO_ACTIVE_BEDS" | "NO_BED_AVAILABLE" | "NO_BOOKING_ADULT";
}

export interface BuildBedAllocationPlanInput {
  enabled: boolean;
  rooms: BedAllocationRoom[];
  bookings: BedAllocationBooking[];
  occupiedBedNights?: OccupiedBedNight[];
  /**
   * When true (issue #1387, the lifecycle auto-allocation path), capacity-
   * holding bookings are allocated before provisional ones and may displace
   * provisional occupants — relocating each displaced booking's WHOLE stay to
   * one other room, else unallocating the whole stay (issue #1677) — to claim
   * the beds a provisional booking is blocking. A capacity-holding occupant is
   * never displaced. Default false emits no displacements, so the admin board
   * preview and any other caller stay displacement-free.
   */
  prioritizeCapacityHolding?: boolean;
}

export interface BedAllocationPlan {
  allocations: BedAllocationCandidate[];
  unallocatedGuestNights: UnallocatedGuestNight[];
  /**
   * Provisional bed-nights displaced so capacity-holding bookings could claim a
   * bed (issue #1387). Present ONLY when at least one displacement occurred, so
   * existing callers/tests that compare the whole plan are unaffected.
   */
  displacements?: BedAllocationDisplacement[];
  /**
   * Bookings for which no single room could host the whole remaining stay —
   * neither in free space nor (for capacity-holding bookings) via displacement
   * — so the plan fell back to the legacy per-night split logic (issue #1677,
   * Phase 3). Present ONLY when at least one booking fell back, mirroring
   * `displacements`.
   */
  roomContinuityFallbackBookingIds?: string[];
}

export interface BedAllocationPersistenceClient {
  bedAllocation: {
    deleteMany: (args: { where: { bookingId: string } }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{
        bookingId: string;
        bookingGuestId: string;
        roomId: string;
        bedId: string;
        stayDate: Date;
        source: BedAllocationSource;
      }>;
    }) => Promise<{ count: number }>;
  };
}

function compareSortThenName<T extends { sortOrder?: number | null; name: string; id: string }>(
  a: T,
  b: T,
) {
  const sortDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (sortDiff !== 0) return sortDiff;
  const nameDiff = a.name.localeCompare(b.name);
  return nameDiff !== 0 ? nameDiff : a.id.localeCompare(b.id);
}

function normalizeStayDate(value: string | Date): string {
  return typeof value === "string" ? value : formatDateOnly(value);
}

function occupiedKey(bedId: string, stayDate: string) {
  return `${bedId}:${stayDate}`;
}

function guestNightKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

interface SortedRoomWithBeds extends BedAllocationRoom {
  beds: BedAllocationBed[];
}

function sortedActiveRoomsWithBeds(
  rooms: BedAllocationRoom[],
): SortedRoomWithBeds[] {
  return [...rooms]
    .filter((room) => room.active !== false)
    .sort(compareSortThenName)
    .map((room) => ({
      ...room,
      beds: [...room.beds]
        .filter((bed) => bed.active !== false)
        .sort(compareSortThenName)
        .map((bed) => ({ ...bed, roomId: room.id })),
    }));
}

// Lodge isolation, enforced at the matcher itself (defence in depth): a
// booking may only be placed in rooms at its own lodge, so cross-lodge
// allocation is impossible even when the caller pools several lodges' rooms
// (club-wide auto-allocation). Null-tolerant during the expand release — a
// booking or room with a null lodgeId is club-wide-compatible, mirroring
// lodgeNullTolerantScope. Manual allocation already enforces this server-side;
// this closes the same guarantee for the auto/first-fit path.
function roomsAtLodge(
  rooms: SortedRoomWithBeds[],
  lodgeId: string | null | undefined,
): SortedRoomWithBeds[] {
  if (lodgeId == null) return rooms;
  return rooms.filter(
    (room) => room.lodgeId == null || room.lodgeId === lodgeId,
  );
}

/**
 * Returns `rooms` lodge-scoped and reordered so the booking's requested room
 * (if active and present) is tried first. If there is no request, or the
 * requested room is not in `rooms` (inactive, deleted, or never set), the
 * lodge-scoped order is returned unchanged — the request is silently treated
 * as no preference.
 */
function roomsForBooking(
  rooms: SortedRoomWithBeds[],
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  const lodgeScoped = roomsAtLodge(rooms, booking.lodgeId);
  const requestedRoomId = booking.requestedRoomId;
  if (!requestedRoomId) return lodgeScoped;

  const requestedIndex = lodgeScoped.findIndex(
    (room) => room.id === requestedRoomId,
  );
  if (requestedIndex <= 0) return lodgeScoped;

  const reordered = [...lodgeScoped];
  const [requestedRoom] = reordered.splice(requestedIndex, 1);
  reordered.unshift(requestedRoom);
  return reordered;
}

function guestStayNights(guest: BedAllocationGuest): string[] {
  return eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
}

function isAdultAgeTier(ageTier?: BedAllocationAgeTier | null): boolean {
  return !ageTier || ageTier === "ADULT";
}

/** A booking guest reduced to what per-night placement needs. */
interface PartyGuest {
  id: string;
  ageTier?: BedAllocationAgeTier | null;
}

/** A party guest with the (sorted, date-only) nights it still needs a bed on. */
interface StayGuest extends PartyGuest {
  nights: string[];
}

/**
 * A booking's remaining whole-stay demand (issue #1677): the still-unallocated
 * guests, the union of their nights, and the demanded guests per night. Built
 * from per-night pseudo-guest entries or contiguous ranges alike — both caller
 * shapes group to the same structure.
 */
interface BookingStayDemand {
  guests: StayGuest[];
  nights: string[];
  guestsByNight: Map<string, StayGuest[]>;
}

function isAdultGuest(guest: PartyGuest): boolean {
  return isAdultAgeTier(guest.ageTier);
}

/** Stable adults-first ordering for bed assignment and displacement passes. */
function adultsFirst<T extends PartyGuest>(guests: T[]): T[] {
  return [...guests].sort(
    (a, b) => Number(isAdultGuest(b)) - Number(isAdultGuest(a)),
  );
}

/**
 * Groups a booking's guest entries by guest id into whole-stay night sets
 * (issue #1677). Both callers feed the planner per-night pseudo-guests (the
 * same guest id repeated once per missing night), so grouping restores the
 * whole-stay view; contiguous stayStart/stayEnd ranges expand to the same
 * shape. Non-contiguous #713 stays arrive naturally as gapped night sets.
 * Guest order is first-appearance input order (deterministic).
 */
function groupBookingGuests(booking: BedAllocationBooking): StayGuest[] {
  const nightSets = new Map<string, Set<string>>();
  const ageTiers = new Map<string, BedAllocationAgeTier | null | undefined>();
  const order: string[] = [];

  for (const guest of booking.guests) {
    let nights = nightSets.get(guest.id);
    if (!nights) {
      nights = new Set();
      nightSets.set(guest.id, nights);
      ageTiers.set(guest.id, guest.ageTier);
      order.push(guest.id);
    }
    for (const night of guestStayNights(guest)) {
      nights.add(night);
    }
  }

  return order.map((id) => ({
    id,
    ageTier: ageTiers.get(id),
    nights: [...(nightSets.get(id) ?? [])].sort(),
  }));
}

function buildStayDemand(guests: StayGuest[]): BookingStayDemand {
  const withNights = guests.filter((guest) => guest.nights.length > 0);
  const nightSet = new Set<string>();
  for (const guest of withNights) {
    for (const night of guest.nights) nightSet.add(night);
  }
  const nights = [...nightSet].sort();
  const guestsByNight = new Map<string, StayGuest[]>();
  for (const night of nights) {
    guestsByNight.set(
      night,
      withNights.filter((guest) => guest.nights.includes(night)),
    );
  }
  return { guests: withNights, nights, guestsByNight };
}

/**
 * A live view of one existing allocation row (issue #1677). Displacement moves
 * whole bookings, so the planner tracks every known occupant row per booking
 * and keeps the view current as displacements relocate rows within a run.
 */
interface OccupantInfo {
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  bedId: string;
  stayDate: string;
  ageTier?: BedAllocationAgeTier | null;
  holdsCapacity: boolean;
  /** Admin-approved (#776 lock): pins the whole booking (issues #1387/#1677). */
  isApproved: boolean;
  /** Occupying booking's createdAt (ms) — newest-first eviction order. 0 = unknown/oldest. */
  bookingCreatedAtMs: number;
  /** Stay extends beyond the loaded window → whole-stay move impossible → pinned. */
  stayExtendsBeyondWindow: boolean;
}

interface PlannerState {
  activeRooms: SortedRoomWithBeds[];
  /** Every active bed (all rooms) — the NO_ACTIVE_BEDS vs NO_BED_AVAILABLE signal. */
  allBeds: BedAllocationBed[];
  occupied: Set<string>;
  /**
   * The occupancy at plan start — the DATABASE state (never mutated). MOVE
   * destinations must have been free here (or be the moving guest's own
   * current bed): the lifecycle applies displacements one row at a time
   * against `@@unique([bedId, stayDate])`, so a MOVE onto a bed another
   * displaced row has not yet vacated would conflict mid-apply. Restricting
   * targets to plan-start-free beds makes the apply order-independent.
   */
  occupiedAtStart: Set<string>;
  occupantByKey: Map<string, OccupantInfo>;
  occupantsByBooking: Map<string, Map<string, OccupantInfo>>;
  allocatedGuestNights: Set<string>;
  allocations: BedAllocationCandidate[];
  unallocatedGuestNights: UnallocatedGuestNight[];
  displacementByGuestNight: Map<string, BedAllocationDisplacement>;
}

function setOccupant(state: PlannerState, info: OccupantInfo) {
  state.occupantByKey.set(occupiedKey(info.bedId, info.stayDate), info);
  let rows = state.occupantsByBooking.get(info.bookingId);
  if (!rows) {
    rows = new Map();
    state.occupantsByBooking.set(info.bookingId, rows);
  }
  rows.set(guestNightKey(info.bookingGuestId, info.stayDate), info);
}

/**
 * Rooms in which `bookingId` currently has an ADULT allocation on `stayDate`
 * (room-specific, from the LIVE occupancy view). A minor may only be
 * auto-placed into one of these rooms when no party adult shares the night.
 */
function liveExistingAdultRoomIds(
  state: PlannerState,
  bookingId: string,
  stayDate: string,
): Set<string> {
  const rooms = new Set<string>();
  const rows = state.occupantsByBooking.get(bookingId);
  if (!rows) return rooms;
  for (const row of rows.values()) {
    if (row.stayDate !== stayDate || !row.roomId) continue;
    if (isAdultAgeTier(row.ageTier)) rooms.add(row.roomId);
  }
  return rooms;
}

/**
 * Whether the whole booking behind `bookingId` may be displaced (issue #1677):
 * every visible occupant row must be non-capacity-holding, none may be
 * admin-approved (one approved night anywhere pins the booking entirely), and
 * the stay must not extend beyond the loaded window.
 */
function isBookingWhollyDisplaceable(
  state: PlannerState,
  bookingId: string,
): boolean {
  const rows = state.occupantsByBooking.get(bookingId);
  if (!rows || rows.size === 0) return false;
  for (const row of rows.values()) {
    if (row.holdsCapacity || row.isApproved || row.stayExtendsBeyondWindow) {
      return false;
    }
  }
  return true;
}

function allocationReasonForNoBed(beds: BedAllocationBed[]) {
  return beds.length === 0 ? "NO_ACTIVE_BEDS" : "NO_BED_AVAILABLE";
}

function roomHasAvailableBeds(
  room: SortedRoomWithBeds,
  stayDate: string,
  occupied: Set<string>,
): BedAllocationBed[] {
  return room.beds.filter((bed) => !occupied.has(occupiedKey(bed.id, stayDate)));
}

function createAllocation(
  bookingId: string,
  guest: PartyGuest,
  bed: BedAllocationBed,
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
): BedAllocationCandidate {
  occupied.add(occupiedKey(bed.id, stayDate));
  allocatedGuestNights.add(guestNightKey(guest.id, stayDate));

  return {
    bookingId,
    bookingGuestId: guest.id,
    roomId: bed.roomId,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  };
}

function allocateGuestsToBeds(
  bookingId: string,
  guests: PartyGuest[],
  beds: BedAllocationBed[],
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
) {
  for (let index = 0; index < guests.length; index += 1) {
    allocations.push(
      createAllocation(
        bookingId,
        guests[index],
        beds[index],
        stayDate,
        occupied,
        allocatedGuestNights,
      ),
    );
  }
}

function addUnallocatedGuestNights(
  bookingId: string,
  guests: PartyGuest[],
  stayDate: string,
  reason: UnallocatedGuestNight["reason"],
  unallocatedGuestNights: UnallocatedGuestNight[],
) {
  for (const guest of guests) {
    unallocatedGuestNights.push({
      bookingId,
      bookingGuestId: guest.id,
      stayDate,
      reason,
    });
  }
}

function tryAllocateWholeBookingNight(
  bookingId: string,
  guests: PartyGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
  existingAdultRooms: Set<string>,
): boolean {
  const hasMinor = guests.some((guest) => !isAdultGuest(guest));
  const hasAdult = guests.some(isAdultGuest);

  if (hasMinor && !hasAdult && existingAdultRooms.size === 0) {
    return false;
  }

  for (const room of rooms) {
    if (hasMinor && !hasAdult && !existingAdultRooms.has(room.id)) {
      continue;
    }

    const availableBeds = roomHasAvailableBeds(room, stayDate, occupied);

    if (availableBeds.length >= guests.length) {
      allocateGuestsToBeds(
        bookingId,
        guests,
        availableBeds,
        stayDate,
        occupied,
        allocatedGuestNights,
        allocations,
      );
      return true;
    }
  }

  return false;
}

function allocateAdultsAcrossBeds(
  bookingId: string,
  adults: PartyGuest[],
  availableBeds: BedAllocationBed[],
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
  unallocatedGuestNights: UnallocatedGuestNight[],
  unallocatedReason: UnallocatedGuestNight["reason"],
) {
  const allocatedAdults = adults.slice(0, availableBeds.length);
  const unallocatedAdults = adults.slice(availableBeds.length);

  allocateGuestsToBeds(
    bookingId,
    allocatedAdults,
    availableBeds.slice(0, allocatedAdults.length),
    stayDate,
    occupied,
    allocatedGuestNights,
    allocations,
  );
  addUnallocatedGuestNights(
    bookingId,
    unallocatedAdults,
    stayDate,
    unallocatedReason,
    unallocatedGuestNights,
  );
}

function allocateSplitBookingNight(
  bookingId: string,
  guests: PartyGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  beds: BedAllocationBed[],
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
  unallocatedGuestNights: UnallocatedGuestNight[],
  existingAdultRooms: Set<string>,
) {
  const adults = guests.filter(isAdultGuest);
  const minors = guests.filter((guest) => !isAdultGuest(guest));
  const roomAvailability = rooms
    .map((room, roomIndex) => ({
      roomId: room.id,
      roomIndex,
      beds: roomHasAvailableBeds(room, stayDate, occupied),
    }))
    .filter((room) => room.beds.length > 0);

  if (minors.length === 0) {
    allocateAdultsAcrossBeds(
      bookingId,
      adults,
      roomAvailability.flatMap((room) => room.beds),
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
      unallocatedGuestNights,
      allocationReasonForNoBed(beds),
    );
    return;
  }

  if (adults.length === 0 && existingAdultRooms.size === 0) {
    addUnallocatedGuestNights(
      bookingId,
      minors,
      stayDate,
      "NO_BOOKING_ADULT",
      unallocatedGuestNights,
    );
    return;
  }

  const remainingAdults = [...adults];
  const remainingMinors = [...minors];
  const roomsWithExistingAdults = roomAvailability
    .filter((room) => existingAdultRooms.has(room.roomId))
    .sort((a, b) => a.roomIndex - b.roomIndex);

  for (const room of roomsWithExistingAdults) {
    if (remainingMinors.length === 0) break;

    const roomMinors = remainingMinors.splice(0, room.beds.length);
    const roomBeds = room.beds.splice(0, roomMinors.length);

    allocateGuestsToBeds(
      bookingId,
      roomMinors,
      roomBeds,
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
    );
  }

  const roomsForMinors = roomAvailability
    .filter((room) => room.beds.length >= 2)
    .sort((a, b) => {
      const capacityDiff = b.beds.length - a.beds.length;
      return capacityDiff !== 0 ? capacityDiff : a.roomIndex - b.roomIndex;
    });

  for (const room of roomsForMinors) {
    if (remainingAdults.length === 0 || remainingMinors.length === 0) break;

    const adult = remainingAdults.shift();
    if (!adult) break;

    const roomMinors = remainingMinors.splice(0, room.beds.length - 1);
    const roomGuests = [adult, ...roomMinors];
    const roomBeds = room.beds.splice(0, roomGuests.length);

    allocateGuestsToBeds(
      bookingId,
      roomGuests,
      roomBeds,
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
    );
  }

  const leftoverBeds = roomAvailability.flatMap((room) => room.beds);
  allocateAdultsAcrossBeds(
    bookingId,
    remainingAdults,
    leftoverBeds,
    stayDate,
    occupied,
    allocatedGuestNights,
    allocations,
    unallocatedGuestNights,
    allocationReasonForNoBed(beds),
  );

  addUnallocatedGuestNights(
    bookingId,
    remainingMinors,
    stayDate,
    allocationReasonForNoBed(beds),
    unallocatedGuestNights,
  );
}

/**
 * The rooms in which a capacity-holding booking already has (or, this run, has
 * just been given) an adult on `stayDate` (issue #1387). A displaced-in minor
 * may only take a bed in one of these rooms, preserving the adult-supervision
 * invariant the normal split path enforces.
 */
function adultRoomsForBookingNight(
  booking: BedAllocationBooking,
  stayDate: string,
  existingAdultRooms: Set<string>,
  allocations: BedAllocationCandidate[],
): Set<string> {
  const rooms = new Set(existingAdultRooms);
  const adultGuestIds = new Set(
    booking.guests.filter(isAdultGuest).map((guest) => guest.id),
  );

  for (const allocation of allocations) {
    if (
      allocation.bookingId === booking.id &&
      allocation.stayDate === stayDate &&
      adultGuestIds.has(allocation.bookingGuestId)
    ) {
      rooms.add(allocation.roomId);
    }
  }

  return rooms;
}

/**
 * Record a displacement, keyed by the provisional guest-night so a provisional
 * occupant displaced more than once in a single run collapses to ONE final
 * action (the latest destination / UNALLOCATE), keeping the lifecycle apply and
 * audit to a single update-or-delete per row while preserving the ORIGINAL
 * from-bed for the audit trail. Issue #1387.
 */
function upsertDisplacement(
  displacementByGuestNight: Map<string, BedAllocationDisplacement>,
  displacement: BedAllocationDisplacement,
) {
  const key = guestNightKey(displacement.bookingGuestId, displacement.stayDate);
  const existing = displacementByGuestNight.get(key);
  displacementByGuestNight.set(
    key,
    existing
      ? {
          ...displacement,
          fromBedId: existing.fromBedId,
          fromRoomId: existing.fromRoomId,
        }
      : displacement,
  );
}

function removeUnallocatedGuestNight(
  unallocatedGuestNights: UnallocatedGuestNight[],
  bookingGuestId: string,
  stayDate: string,
) {
  const index = unallocatedGuestNights.findIndex(
    (guestNight) =>
      guestNight.bookingGuestId === bookingGuestId &&
      guestNight.stayDate === stayDate,
  );
  if (index >= 0) {
    unallocatedGuestNights.splice(index, 1);
  }
}

/**
 * Phase 0 (issue #1677): the adult-coverage carve-out. A minor's night is
 * coverable iff a party adult also stays that night (the whole party lands in
 * one room, so the adult covers it) or the booking already has an adult
 * allocation on that night (room-specific pinning is enforced later, in the
 * room feasibility check). Uncoverable minor-nights are removed from the
 * demand and reported NO_BOOKING_ADULT — matching the legacy per-night rule.
 */
function applyAdultCoverageCarveOut(
  state: PlannerState,
  booking: BedAllocationBooking,
  guests: StayGuest[],
): StayGuest[] {
  const adultNights = new Set<string>();
  for (const guest of guests) {
    if (!isAdultGuest(guest)) continue;
    for (const night of guest.nights) adultNights.add(night);
  }

  const dropped: Array<{ guestId: string; night: string; guestIndex: number }> =
    [];
  const covered = guests
    .map((guest, guestIndex) => {
      if (isAdultGuest(guest)) return guest;
      const kept: string[] = [];
      for (const night of guest.nights) {
        if (
          adultNights.has(night) ||
          liveExistingAdultRoomIds(state, booking.id, night).size > 0
        ) {
          kept.push(night);
        } else {
          dropped.push({ guestId: guest.id, night, guestIndex });
        }
      }
      return { ...guest, nights: kept };
    })
    .filter((guest) => guest.nights.length > 0);

  dropped.sort(
    (a, b) => a.night.localeCompare(b.night) || a.guestIndex - b.guestIndex,
  );
  for (const drop of dropped) {
    state.unallocatedGuestNights.push({
      bookingId: booking.id,
      bookingGuestId: drop.guestId,
      stayDate: drop.night,
      reason: "NO_BOOKING_ADULT",
    });
  }

  return covered;
}

/**
 * Candidate room order for whole-stay placement (issue #1677):
 *   1. rooms already holding this booking's existing allocations (desc row
 *      count) so date-extensions and partial re-fills stay put;
 *   2. the booking's requested room (`roomsForBooking` reorder);
 *   3. room sort order.
 * Lodge scoping (`roomsAtLodge`, inside `roomsForBooking`) stays mandatory.
 * The count sort is stable, so ties keep the requested-first/sortOrder order.
 */
function orderedCandidateRooms(
  state: PlannerState,
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  const base = roomsForBooking(state.activeRooms, booking);
  const rows = state.occupantsByBooking.get(booking.id);
  if (!rows || rows.size === 0) return base;

  const counts = new Map<string, number>();
  for (const row of rows.values()) {
    counts.set(row.roomId, (counts.get(row.roomId) ?? 0) + 1);
  }
  return [...base].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
  );
}

/**
 * Whether `room` can host the whole demanded stay in FREE space: for every
 * night, at least as many free beds as demanded guests, and (when
 * `coverageBookingId` is given) every minors-only night covered by an existing
 * adult allocation of that booking in THIS room. Re-planning a displaced
 * booking passes null — the whole party moves together, so coverage cannot get
 * worse than it already was.
 */
function roomHostsWholeStay(
  state: PlannerState,
  room: SortedRoomWithBeds,
  demand: BookingStayDemand,
  coverageBookingId: string | null,
  bedNightUsable?: (bedId: string, night: string) => boolean,
): boolean {
  for (const night of demand.nights) {
    const guests = demand.guestsByNight.get(night) ?? [];
    let free = 0;
    for (const bed of room.beds) {
      const usable = bedNightUsable
        ? bedNightUsable(bed.id, night)
        : !state.occupied.has(occupiedKey(bed.id, night));
      if (usable) free += 1;
    }
    if (free < guests.length) return false;

    if (coverageBookingId !== null) {
      const hasAdult = guests.some(isAdultGuest);
      const hasMinor = guests.some((guest) => !isAdultGuest(guest));
      if (
        hasMinor &&
        !hasAdult &&
        !liveExistingAdultRoomIds(state, coverageBookingId, night).has(room.id)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Per-guest preferred beds in `roomId` from a set of existing rows: the bed a
 * guest holds on its earliest night in that room. Keeps a guest on its current
 * bed across date-extensions and whole-booking relocations back into (or
 * within) a room it already occupies.
 */
function preferredBedsInRoom(
  rows: Iterable<OccupantInfo>,
  roomId: string,
): Map<string, string> {
  const earliest = new Map<string, OccupantInfo>();
  for (const row of rows) {
    if (row.roomId !== roomId) continue;
    const current = earliest.get(row.bookingGuestId);
    if (!current || row.stayDate < current.stayDate) {
      earliest.set(row.bookingGuestId, row);
    }
  }
  const preferred = new Map<string, string>();
  for (const [guestId, row] of earliest) preferred.set(guestId, row.bedId);
  return preferred;
}

interface RoomBedAssignment {
  guest: StayGuest;
  stayDate: string;
  bed: BedAllocationBed;
}

/**
 * Assigns a whole party to beds within ONE feasible room (issue #1677). Bed
 * stability is best-effort: per guest (adults first, then input order), the
 * preferred bed (if any) then the first bed in sort order that is free on ALL
 * of the guest's nights; when no single bed spans the stay, the guest takes
 * the first free bed per night WITHIN the same room. Per-night feasibility
 * (checked by the caller) guarantees completion. Marks `state.occupied`.
 */
function assignGuestsToRoomBeds(
  state: PlannerState,
  room: SortedRoomWithBeds,
  guests: StayGuest[],
  preferredBedByGuest?: Map<string, string>,
  bedNightUsableForGuest?: (
    guest: StayGuest,
    bedId: string,
    night: string,
  ) => boolean,
): RoomBedAssignment[] {
  const assignments: RoomBedAssignment[] = [];
  const usable = (guest: StayGuest, bedId: string, night: string) =>
    bedNightUsableForGuest
      ? bedNightUsableForGuest(guest, bedId, night)
      : !state.occupied.has(occupiedKey(bedId, night));

  for (const guest of adultsFirst(guests)) {
    const preferredBedId = preferredBedByGuest?.get(guest.id);
    const bedsInOrder = preferredBedId
      ? [
          ...room.beds.filter((bed) => bed.id === preferredBedId),
          ...room.beds.filter((bed) => bed.id !== preferredBedId),
        ]
      : room.beds;

    const stableBed = bedsInOrder.find((bed) =>
      guest.nights.every((night) => usable(guest, bed.id, night)),
    );
    if (stableBed) {
      for (const night of guest.nights) {
        state.occupied.add(occupiedKey(stableBed.id, night));
        assignments.push({ guest, stayDate: night, bed: stableBed });
      }
      continue;
    }

    for (const night of guest.nights) {
      const bed = bedsInOrder.find((candidate) =>
        usable(guest, candidate.id, night),
      );
      if (!bed) continue; // unreachable: per-night feasibility was checked
      state.occupied.add(occupiedKey(bed.id, night));
      assignments.push({ guest, stayDate: night, bed });
    }
  }

  return assignments;
}

/** Phase 1/2 placement: the whole demanded stay lands in `room`. */
function placePartyInRoom(
  state: PlannerState,
  booking: BedAllocationBooking,
  room: SortedRoomWithBeds,
  demand: BookingStayDemand,
) {
  const rows = state.occupantsByBooking.get(booking.id);
  const preferred = rows
    ? preferredBedsInRoom(rows.values(), room.id)
    : undefined;
  const assignments = assignGuestsToRoomBeds(
    state,
    room,
    demand.guests,
    preferred,
  );
  const sorted = [...assignments].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate),
  );
  for (const assignment of sorted) {
    state.allocatedGuestNights.add(
      guestNightKey(assignment.guest.id, assignment.stayDate),
    );
    state.allocations.push({
      bookingId: booking.id,
      bookingGuestId: assignment.guest.id,
      roomId: room.id,
      bedId: assignment.bed.id,
      stayDate: assignment.stayDate,
      source: "AUTO",
    });
  }
}

interface DisplacedBookingSnapshot {
  bookingId: string;
  /** The evicted rows, sorted by (stayDate, bedId) — a deterministic snapshot. */
  rows: OccupantInfo[];
}

/**
 * Frees every visible allocation row of a provisional booking (issue #1677).
 * The rows are returned as a snapshot for the subsequent whole-stay
 * MOVE-or-UNALLOCATE re-plan. The displaced guest-nights stay in
 * `allocatedGuestNights`: an UNALLOCATE returns them to the awaiting queue for
 * the NEXT run rather than re-entering this run's demand.
 */
function evictBooking(
  state: PlannerState,
  bookingId: string,
): DisplacedBookingSnapshot {
  const rowsMap = state.occupantsByBooking.get(bookingId);
  const rows = rowsMap ? [...rowsMap.values()] : [];
  rows.sort(
    (a, b) =>
      a.stayDate.localeCompare(b.stayDate) || a.bedId.localeCompare(b.bedId),
  );
  for (const row of rows) {
    const key = occupiedKey(row.bedId, row.stayDate);
    state.occupied.delete(key);
    state.occupantByKey.delete(key);
  }
  state.occupantsByBooking.delete(bookingId);
  return { bookingId, rows };
}

/**
 * Re-plans an evicted provisional booking's ENTIRE stay (issue #1677): find
 * ONE room (never `excludedRoomId`, never another lodge's room) that can host
 * every night of the stay and MOVE the rows there (a row that keeps its bed
 * emits no record — nothing moved); when no single room fits, emit UNALLOCATE
 * for ALL rows. A booking is never partially relocated and never receives
 * mixed MOVE/UNALLOCATE records in one plan.
 *
 * Apply-safety: a MOVE destination must have been free in the DATABASE at
 * plan start (or be the moving guest's own current bed). Beds vacated by
 * OTHER displacements in this plan are off limits — the lifecycle applies
 * displacements row by row against `@@unique([bedId, stayDate])`, and a
 * chained MOVE onto a not-yet-vacated bed would conflict mid-apply.
 */
function relocateOrUnallocateBooking(
  state: PlannerState,
  snapshot: DisplacedBookingSnapshot,
  displacedByBookingId: string,
  excludedRoomId?: string,
) {
  const { bookingId, rows } = snapshot;
  if (rows.length === 0) return;

  const guestOrder: string[] = [];
  const nightsByGuest = new Map<string, string[]>();
  const ageTierByGuest = new Map<
    string,
    BedAllocationAgeTier | null | undefined
  >();
  for (const row of rows) {
    let nights = nightsByGuest.get(row.bookingGuestId);
    if (!nights) {
      nights = [];
      nightsByGuest.set(row.bookingGuestId, nights);
      ageTierByGuest.set(row.bookingGuestId, row.ageTier);
      guestOrder.push(row.bookingGuestId);
    }
    nights.push(row.stayDate);
  }
  const demand = buildStayDemand(
    guestOrder.map((guestId) => ({
      id: guestId,
      ageTier: ageTierByGuest.get(guestId),
      nights: [...(nightsByGuest.get(guestId) ?? [])].sort(),
    })),
  );

  const ownRowKeys = new Set(
    rows.map((row) => occupiedKey(row.bedId, row.stayDate)),
  );
  const ownKeysByGuest = new Map<string, Set<string>>();
  for (const row of rows) {
    let keys = ownKeysByGuest.get(row.bookingGuestId);
    if (!keys) {
      keys = new Set();
      ownKeysByGuest.set(row.bookingGuestId, keys);
    }
    keys.add(occupiedKey(row.bedId, row.stayDate));
  }
  const bedNightUsable = (bedId: string, night: string) => {
    const key = occupiedKey(bedId, night);
    if (state.occupied.has(key)) return false;
    return !state.occupiedAtStart.has(key) || ownRowKeys.has(key);
  };
  const bedNightUsableForGuest = (
    guest: StayGuest,
    bedId: string,
    night: string,
  ) => {
    const key = occupiedKey(bedId, night);
    if (state.occupied.has(key)) return false;
    if (!state.occupiedAtStart.has(key)) return true;
    return ownKeysByGuest.get(guest.id)?.has(key) ?? false;
  };

  // Lodge isolation through the re-plan (defence in depth): the booking may
  // only be relocated within the lodge of the rooms it already occupies.
  const roomById = new Map(state.activeRooms.map((room) => [room.id, room]));
  let lodgeId: string | null = null;
  for (const row of rows) {
    const room = roomById.get(row.roomId);
    if (room?.lodgeId != null) {
      lodgeId = room.lodgeId;
      break;
    }
  }
  const scoped = roomsAtLodge(state.activeRooms, lodgeId);
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.roomId, (counts.get(row.roomId) ?? 0) + 1);
  }
  const ordered = [...scoped].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
  );

  const unallocateAllRows = () => {
    for (const row of rows) {
      upsertDisplacement(state.displacementByGuestNight, {
        type: "UNALLOCATE",
        bookingId,
        bookingGuestId: row.bookingGuestId,
        stayDate: row.stayDate,
        fromBedId: row.bedId,
        fromRoomId: row.roomId,
        displacedByBookingId,
      });
    }
  };

  const destination = ordered.find(
    (room) =>
      room.id !== excludedRoomId &&
      roomHostsWholeStay(state, room, demand, null, bedNightUsable),
  );

  if (!destination) {
    unallocateAllRows();
    return;
  }

  const preferred = preferredBedsInRoom(rows, destination.id);
  const assignments = assignGuestsToRoomBeds(
    state,
    destination,
    demand.guests,
    preferred,
    bedNightUsableForGuest,
  );
  if (assignments.length !== rows.length) {
    // Defensive: the per-guest availability restriction can, in pathological
    // shapes, leave a guest-night without a bed even though the per-night
    // counts passed. Never partially relocate — roll the trial marks back and
    // unallocate the whole stay instead.
    for (const assignment of assignments) {
      state.occupied.delete(
        occupiedKey(assignment.bed.id, assignment.stayDate),
      );
    }
    unallocateAllRows();
    return;
  }
  const rowByGuestNight = new Map(
    rows.map((row) => [guestNightKey(row.bookingGuestId, row.stayDate), row]),
  );
  const sorted = [...assignments].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate),
  );
  for (const assignment of sorted) {
    const original = rowByGuestNight.get(
      guestNightKey(assignment.guest.id, assignment.stayDate),
    );
    if (!original) continue; // unreachable: assignments mirror the snapshot
    setOccupant(state, {
      ...original,
      roomId: destination.id,
      bedId: assignment.bed.id,
    });
    if (original.bedId !== assignment.bed.id) {
      upsertDisplacement(state.displacementByGuestNight, {
        type: "MOVE",
        bookingId,
        bookingGuestId: assignment.guest.id,
        stayDate: assignment.stayDate,
        fromBedId: original.bedId,
        fromRoomId: original.roomId,
        toBedId: assignment.bed.id,
        toRoomId: destination.id,
        displacedByBookingId,
      });
    }
  }
}

/**
 * Phase 2 room feasibility (issue #1677): which whole provisional bookings must
 * be evicted from `room` so the held demand fits. Returns the eviction list
 * (possibly empty), or null when the room cannot host the stay even with
 * displacement. Per night: freeBeds + beds of wholly-displaceable provisional
 * bookings must cover the demanded party, and the same adult-coverage rule as
 * Phase 1 applies. Eviction order is newest booking first (bookingCreatedAt
 * desc, then bookingId desc), stopping once every night's shortfall is covered.
 */
function planEvictionsForRoom(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  room: SortedRoomWithBeds,
): string[] | null {
  const shortfalls = new Map<string, number>();
  for (const night of demand.nights) {
    const guests = demand.guestsByNight.get(night) ?? [];
    const hasAdult = guests.some(isAdultGuest);
    const hasMinor = guests.some((guest) => !isAdultGuest(guest));
    if (
      hasMinor &&
      !hasAdult &&
      !liveExistingAdultRoomIds(state, booking.id, night).has(room.id)
    ) {
      return null;
    }
    let free = 0;
    for (const bed of room.beds) {
      if (!state.occupied.has(occupiedKey(bed.id, night))) free += 1;
    }
    if (guests.length > free) shortfalls.set(night, guests.length - free);
  }
  if (shortfalls.size === 0) return [];

  const candidateIds = new Set<string>();
  for (const night of shortfalls.keys()) {
    for (const bed of room.beds) {
      const occupant = state.occupantByKey.get(occupiedKey(bed.id, night));
      if (occupant && occupant.bookingId !== booking.id) {
        candidateIds.add(occupant.bookingId);
      }
    }
  }

  const evictable = [...candidateIds]
    .filter((id) => isBookingWhollyDisplaceable(state, id))
    .map((id) => {
      const rows = state.occupantsByBooking.get(id);
      const first = rows?.values().next().value as OccupantInfo | undefined;
      return { id, createdAtMs: first?.bookingCreatedAtMs ?? 0 };
    })
    .sort(
      (a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id),
    );

  const remaining = new Map(shortfalls);
  const chosen: string[] = [];
  for (const candidate of evictable) {
    if (![...remaining.values()].some((deficit) => deficit > 0)) break;
    const rows = state.occupantsByBooking.get(candidate.id);
    if (!rows) continue;
    let helps = false;
    for (const row of rows.values()) {
      if (row.roomId === room.id && (remaining.get(row.stayDate) ?? 0) > 0) {
        helps = true;
        break;
      }
    }
    if (!helps) continue;
    chosen.push(candidate.id);
    for (const row of rows.values()) {
      const deficit = remaining.get(row.stayDate);
      if (row.roomId === room.id && deficit !== undefined) {
        remaining.set(row.stayDate, deficit - 1);
      }
    }
  }
  if ([...remaining.values()].some((deficit) => deficit > 0)) return null;
  return chosen;
}

/**
 * Phase 2 (issue #1677): whole-stay placement for a capacity-holding booking by
 * displacing whole provisional stays (#1387 preserved). The first candidate
 * room that fits with displacement wins; the chosen provisional bookings are
 * evicted whole, the held party is placed (Phase-1 bed rules), and each evicted
 * booking is then relocated to ONE other room or wholly unallocated.
 */
function tryWholeStayWithDisplacement(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  candidateRooms: SortedRoomWithBeds[],
): boolean {
  for (const room of candidateRooms) {
    const evictionBookingIds = planEvictionsForRoom(
      state,
      booking,
      demand,
      room,
    );
    if (!evictionBookingIds) continue;

    const snapshots = evictionBookingIds.map((id) => evictBooking(state, id));
    placePartyInRoom(state, booking, room, demand);
    for (const snapshot of snapshots) {
      relocateOrUnallocateBooking(state, snapshot, booking.id, room.id);
    }
    return true;
  }
  return false;
}

function placeGuestNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guest: PartyGuest,
  room: SortedRoomWithBeds,
  bed: BedAllocationBed,
  stayDate: string,
) {
  state.occupied.add(occupiedKey(bed.id, stayDate));
  state.allocatedGuestNights.add(guestNightKey(guest.id, stayDate));
  state.allocations.push({
    bookingId: booking.id,
    bookingGuestId: guest.id,
    roomId: room.id,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  });
  removeUnallocatedGuestNight(state.unallocatedGuestNights, guest.id, stayDate);
}

/**
 * Phase 3 displacement (issue #1387 × #1677): place a still-unallocated
 * capacity-holding guest-night using the whole-booking displacement primitive.
 * A genuinely-free bed (e.g. freed by an earlier whole-booking eviction this
 * night) is used first; otherwise the first bed held by a WHOLLY-displaceable
 * provisional booking is claimed — that booking's entire stay is then moved to
 * one other room or wholly unallocated. A provisional stay is never
 * night-split by any path. A held minor may only land in a room that has one
 * of its own booking's adults that night.
 */
function tryDisplaceForHeldGuestNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guest: PartyGuest,
  stayDate: string,
  candidateRooms: SortedRoomWithBeds[],
): boolean {
  let allowedRooms = candidateRooms;
  if (!isAdultGuest(guest)) {
    const adultRooms = adultRoomsForBookingNight(
      booking,
      stayDate,
      liveExistingAdultRoomIds(state, booking.id, stayDate),
      state.allocations,
    );
    if (adultRooms.size === 0) {
      return false;
    }
    allowedRooms = candidateRooms.filter((room) => adultRooms.has(room.id));
  }

  for (const room of allowedRooms) {
    for (const bed of room.beds) {
      if (!state.occupied.has(occupiedKey(bed.id, stayDate))) {
        placeGuestNight(state, booking, guest, room, bed, stayDate);
        return true;
      }
    }
  }

  for (const room of allowedRooms) {
    for (const bed of room.beds) {
      const occupant = state.occupantByKey.get(occupiedKey(bed.id, stayDate));
      if (!occupant || occupant.bookingId === booking.id) continue;
      if (!isBookingWhollyDisplaceable(state, occupant.bookingId)) continue;

      const snapshot = evictBooking(state, occupant.bookingId);
      placeGuestNight(state, booking, guest, room, bed, stayDate);
      relocateOrUnallocateBooking(state, snapshot, booking.id);
      return true;
    }
  }

  return false;
}

/**
 * Booking-first, whole-stay-first bed allocation (issue #1677). Per booking
 * (held-first under `prioritizeCapacityHolding`, then createdAt/id):
 *
 *   Phase 0 — adult-coverage carve-out: uncoverable minor-nights leave the
 *   demand as NO_BOOKING_ADULT.
 *   Phase 1 — whole-stay placement in free space: the first candidate room
 *   (existing-allocation rooms, then the requested room, then sort order) that
 *   can host the party on EVERY night takes the whole stay, with best-effort
 *   per-guest bed stability.
 *   Phase 2 — held bookings only: whole-stay placement by displacing whole
 *   provisional stays (newest first); each displaced booking is relocated to
 *   ONE other room or wholly unallocated — never night-split, never mixed.
 *   Phase 3 — last resort: the legacy per-night whole-night/split logic, with
 *   held-booking displacement still using the whole-booking primitive. The
 *   booking id is reported in `roomContinuityFallbackBookingIds`.
 *
 * Pure and deterministic: stable sorts only, no clock or randomness — the
 * admin dashboard re-renders the same plan for the same input.
 */
export function buildFirstFitBedAllocationPlan({
  enabled,
  rooms,
  bookings,
  occupiedBedNights = [],
  prioritizeCapacityHolding = false,
}: BuildBedAllocationPlanInput): BedAllocationPlan {
  if (!enabled) {
    return { allocations: [], unallocatedGuestNights: [] };
  }

  const activeRooms = sortedActiveRoomsWithBeds(rooms);
  const allBeds = activeRooms.flatMap((room) => room.beds);
  const bedRoomIds = new Map(allBeds.map((bed) => [bed.id, bed.roomId]));

  const state: PlannerState = {
    activeRooms,
    allBeds,
    occupied: new Set(),
    occupiedAtStart: new Set(),
    occupantByKey: new Map(),
    occupantsByBooking: new Map(),
    allocatedGuestNights: new Set(),
    allocations: [],
    unallocatedGuestNights: [],
    displacementByGuestNight: new Map(),
  };

  // Age-tier fallback for occupant rows that do not carry their own tier:
  // the planner input's guest entries know it.
  const guestAgeTierById = new Map<
    string,
    BedAllocationAgeTier | null | undefined
  >();
  for (const booking of bookings) {
    for (const guest of booking.guests) {
      if (!guestAgeTierById.has(guest.id)) {
        guestAgeTierById.set(guest.id, guest.ageTier);
      }
    }
  }

  for (const night of occupiedBedNights) {
    const stayDate = normalizeStayDate(night.stayDate);
    state.occupied.add(occupiedKey(night.bedId, stayDate));
    if (night.bookingGuestId) {
      state.allocatedGuestNights.add(
        guestNightKey(night.bookingGuestId, stayDate),
      );
    }
    if (!night.bookingId || !night.bookingGuestId) continue;
    setOccupant(state, {
      bookingId: night.bookingId,
      bookingGuestId: night.bookingGuestId,
      roomId: night.roomId ?? bedRoomIds.get(night.bedId) ?? "",
      bedId: night.bedId,
      stayDate,
      ageTier: night.ageTier ?? guestAgeTierById.get(night.bookingGuestId) ?? null,
      holdsCapacity: night.holdsCapacity === true,
      isApproved: Boolean(night.approvedAt),
      bookingCreatedAtMs: night.bookingCreatedAt
        ? new Date(night.bookingCreatedAt).getTime()
        : 0,
      stayExtendsBeyondWindow: night.stayExtendsBeyondWindow === true,
    });
  }
  // Snapshot the DATABASE occupancy before any planning: MOVE destinations are
  // restricted to beds free here, keeping the lifecycle apply order-safe.
  state.occupiedAtStart = new Set(state.occupied);

  const sortedBookings = [...bookings].sort((a, b) => {
    if (prioritizeCapacityHolding) {
      // Capacity-holding bookings claim genuinely-free beds first (issue #1387),
      // before provisional bookings consume them in the same run. Ties fall back
      // to the stable created-then-id order used everywhere else.
      const holdDiff =
        Number(b.holdsCapacity ?? false) - Number(a.holdsCapacity ?? false);
      if (holdDiff !== 0) return holdDiff;
    }
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    return createdDiff !== 0 ? createdDiff : a.id.localeCompare(b.id);
  });

  const fallbackBookingIds: string[] = [];

  for (const booking of sortedBookings) {
    // Only the missing guest-nights are planned; existing rows are never
    // rewritten (only provisional displacement moves rows).
    const demanded = groupBookingGuests(booking)
      .map((guest) => ({
        ...guest,
        nights: guest.nights.filter(
          (night) =>
            !state.allocatedGuestNights.has(guestNightKey(guest.id, night)),
        ),
      }))
      .filter((guest) => guest.nights.length > 0);
    if (demanded.length === 0) continue;

    const covered = applyAdultCoverageCarveOut(state, booking, demanded);
    const demand = buildStayDemand(covered);
    if (demand.guests.length === 0) continue;

    const candidateRooms = orderedCandidateRooms(state, booking);

    // Phase 1 — whole-stay placement in free space.
    const freeRoom = candidateRooms.find((room) =>
      roomHostsWholeStay(state, room, demand, booking.id),
    );
    if (freeRoom) {
      placePartyInRoom(state, booking, freeRoom, demand);
      continue;
    }

    // Phase 2 — held-only whole-stay via whole-booking displacement.
    if (
      prioritizeCapacityHolding &&
      booking.holdsCapacity &&
      tryWholeStayWithDisplacement(state, booking, demand, candidateRooms)
    ) {
      continue;
    }

    // Phase 3 — per-night split fallback (last resort).
    fallbackBookingIds.push(booking.id);
    for (const stayDate of demand.nights) {
      const guests = (demand.guestsByNight.get(stayDate) ?? []).filter(
        (guest) =>
          !state.allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
      );
      if (guests.length === 0) continue;

      const existingAdultRooms = liveExistingAdultRoomIds(
        state,
        booking.id,
        stayDate,
      );
      const placedWhole = tryAllocateWholeBookingNight(
        booking.id,
        guests,
        stayDate,
        candidateRooms,
        state.occupied,
        state.allocatedGuestNights,
        state.allocations,
        existingAdultRooms,
      );
      if (!placedWhole) {
        allocateSplitBookingNight(
          booking.id,
          guests,
          stayDate,
          candidateRooms,
          state.allBeds,
          state.occupied,
          state.allocatedGuestNights,
          state.allocations,
          state.unallocatedGuestNights,
          existingAdultRooms,
        );
      }

      // Held-booking displacement (issue #1387) still runs in the fallback,
      // but the displacement unit is the whole provisional booking (issue
      // #1677). Adults first, so a minor whose only adult also needs
      // displacing still finds a same-booking adult room.
      if (prioritizeCapacityHolding && booking.holdsCapacity) {
        const stillUnallocated = adultsFirst(
          guests.filter(
            (guest) =>
              !state.allocatedGuestNights.has(
                guestNightKey(guest.id, stayDate),
              ),
          ),
        );
        for (const guest of stillUnallocated) {
          tryDisplaceForHeldGuestNight(
            state,
            booking,
            guest,
            stayDate,
            candidateRooms,
          );
        }
      }
    }
  }

  // A guest-night displaced more than once can collapse to its original bed —
  // nothing actually moved, so no record (and no DB write) is emitted.
  const displacements = [...state.displacementByGuestNight.values()].filter(
    (displacement) =>
      !(
        displacement.type === "MOVE" &&
        displacement.fromBedId === displacement.toBedId
      ),
  );

  const plan: BedAllocationPlan = {
    allocations: state.allocations,
    unallocatedGuestNights: state.unallocatedGuestNights,
  };
  if (displacements.length > 0) {
    plan.displacements = displacements;
  }
  if (fallbackBookingIds.length > 0) {
    plan.roomContinuityFallbackBookingIds = fallbackBookingIds;
  }
  return plan;
}

// test seam
export async function replaceBedAllocationsForBooking(
  client: BedAllocationPersistenceClient,
  bookingId: string,
  allocations: BedAllocationCandidate[],
) {
  await client.bedAllocation.deleteMany({ where: { bookingId } });

  const data = allocations.map((allocation) => ({
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    roomId: allocation.roomId,
    bedId: allocation.bedId,
    stayDate: parseDateOnly(allocation.stayDate),
    source: allocation.source,
  }));

  if (data.length === 0) {
    return { count: 0 };
  }

  return client.bedAllocation.createMany({ data });
}
