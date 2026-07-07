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
   * so it is treated like a capacity-holding occupant even when provisional.
   */
  approvedAt?: Date | string | null;
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
   * holding bookings are allocated before provisional ones and may displace a
   * provisional occupant — moving it to a free bed, else unallocating it — to
   * claim a bed a provisional booking is blocking. A capacity-holding occupant
   * is never displaced. Default false preserves the pure first-fit ordering and
   * emits no displacements, so the admin board preview and any other caller are
   * byte-for-byte unchanged.
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

function bookingNightKey(bookingId: string, stayDate: string) {
  return `${bookingId}:${stayDate}`;
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

/**
 * Returns `rooms` reordered so the booking's requested room (if active and
 * present) is tried first. If there is no request, or the requested room is
 * not in `rooms` (inactive, deleted, or never set), the original order is
 * returned unchanged — the request is silently treated as no preference.
 */
// Lodge isolation, enforced at the matcher itself (defence in depth): a
// booking may only be placed in rooms at its own lodge, so cross-lodge
// allocation is impossible even when the caller pools several lodges' rooms
// (club-wide auto-allocation). Null-tolerant during the expand release — a
// booking or room with a null lodgeId is club-wide-compatible, mirroring
// lodgeNullTolerantScope. Manual allocation already enforces this server-side;
// this closes the same guarantee for the auto/first-fit path.
function roomsAtBookingLodge(
  rooms: SortedRoomWithBeds[],
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  if (booking.lodgeId == null) return rooms;
  return rooms.filter(
    (room) => room.lodgeId == null || room.lodgeId === booking.lodgeId,
  );
}

function roomsForBooking(
  rooms: SortedRoomWithBeds[],
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  const lodgeScoped = roomsAtBookingLodge(rooms, booking);
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

function bookingStayNights(booking: BedAllocationBooking): Array<{
  stayDate: string;
  guests: BedAllocationGuest[];
}> {
  const guestsByNight = new Map<string, BedAllocationGuest[]>();

  for (const guest of booking.guests) {
    for (const stayDate of guestStayNights(guest)) {
      const guests = guestsByNight.get(stayDate) ?? [];
      guests.push(guest);
      guestsByNight.set(stayDate, guests);
    }
  }

  return [...guestsByNight.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stayDate, guests]) => ({ stayDate, guests }));
}

function isAdultAgeTier(ageTier?: BedAllocationAgeTier | null): boolean {
  return !ageTier || ageTier === "ADULT";
}

function isAdultGuest(guest: BedAllocationGuest): boolean {
  return isAdultAgeTier(guest.ageTier);
}

function roomHasAvailableBeds(
  room: SortedRoomWithBeds,
  stayDate: string,
  occupied: Set<string>,
): BedAllocationBed[] {
  return room.beds.filter((bed) => !occupied.has(occupiedKey(bed.id, stayDate)));
}

function existingAllocationsByBookingNight(
  occupiedBedNights: OccupiedBedNight[],
) {
  const existing = new Map<string, OccupiedBedNight[]>();

  for (const occupiedBedNight of occupiedBedNights) {
    if (!occupiedBedNight.bookingId) continue;

    const stayDate = normalizeStayDate(occupiedBedNight.stayDate);
    const key = bookingNightKey(occupiedBedNight.bookingId, stayDate);
    const bookingNight = existing.get(key) ?? [];
    bookingNight.push(occupiedBedNight);
    existing.set(key, bookingNight);
  }

  return existing;
}

function existingAdultRoomIds(
  existingAllocations: OccupiedBedNight[],
  guests: BedAllocationGuest[],
) {
  const guestById = new Map(guests.map((guest) => [guest.id, guest]));
  const roomIds = new Set<string>();

  for (const allocation of existingAllocations) {
    if (!allocation.roomId || !allocation.bookingGuestId) continue;

    const existingGuest = guestById.get(allocation.bookingGuestId);
    const ageTier = allocation.ageTier ?? existingGuest?.ageTier;
    if (!isAdultAgeTier(ageTier)) {
      continue;
    }

    roomIds.add(allocation.roomId);
  }

  return roomIds;
}

function allocationReasonForNoBed(beds: BedAllocationBed[]) {
  return beds.length === 0 ? "NO_ACTIVE_BEDS" : "NO_BED_AVAILABLE";
}

function createAllocation(
  booking: BedAllocationBooking,
  guest: BedAllocationGuest,
  bed: BedAllocationBed,
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
): BedAllocationCandidate {
  occupied.add(occupiedKey(bed.id, stayDate));
  allocatedGuestNights.add(guestNightKey(guest.id, stayDate));

  return {
    bookingId: booking.id,
    bookingGuestId: guest.id,
    roomId: bed.roomId,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  };
}

function allocateGuestsToBeds(
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
  beds: BedAllocationBed[],
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
) {
  for (let index = 0; index < guests.length; index += 1) {
    allocations.push(
      createAllocation(
        booking,
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
  guests: BedAllocationGuest[],
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
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
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
        booking,
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
  booking: BedAllocationBooking,
  adults: BedAllocationGuest[],
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
    booking,
    allocatedAdults,
    availableBeds.slice(0, allocatedAdults.length),
    stayDate,
    occupied,
    allocatedGuestNights,
    allocations,
  );
  addUnallocatedGuestNights(
    booking.id,
    unallocatedAdults,
    stayDate,
    unallocatedReason,
    unallocatedGuestNights,
  );
}

function allocateSplitBookingNight(
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
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
      booking,
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
      booking.id,
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
      booking,
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
      booking,
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
    booking,
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
    booking.id,
    remainingMinors,
    stayDate,
    allocationReasonForNoBed(beds),
    unallocatedGuestNights,
  );
}

interface OccupantInfo {
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  stayDate: string;
  ageTier?: BedAllocationAgeTier | null;
  holdsCapacity: boolean;
  /** Admin-approved (#776 lock): never displaced (issue #1387). */
  isApproved: boolean;
}

/** Rooms in which `bookingId` has an adult on `stayDate`, from current occupancy. */
function bookingAdultRoomsFromOccupants(
  occupantByKey: Map<string, OccupantInfo>,
  bookingId: string,
  stayDate: string,
): Set<string> {
  const rooms = new Set<string>();
  for (const occupant of occupantByKey.values()) {
    if (
      occupant.bookingId === bookingId &&
      occupant.stayDate === stayDate &&
      isAdultAgeTier(occupant.ageTier)
    ) {
      rooms.add(occupant.roomId);
    }
  }
  return rooms;
}

/**
 * Would displacing this ADULT provisional occupant strand a same-booking minor
 * that shares its room on `stayDate`? True when a same-booking minor remains in
 * the room and no OTHER same-booking adult would be left to supervise it. Such
 * an occupant is left in place (issue #1387) — displacement must never create an
 * unsupervised-minor room for the DISPLACED booking, mirroring the invariant the
 * normal split path enforces for the booking being placed.
 */
function displacingAdultStrandsSameBookingMinor(
  occupantByKey: Map<string, OccupantInfo>,
  occupant: OccupantInfo,
  targetKey: string,
  stayDate: string,
): boolean {
  let sameRoomMinor = false;
  let otherSameRoomAdult = false;
  for (const [key, other] of occupantByKey) {
    if (key === targetKey) continue;
    if (
      other.bookingId !== occupant.bookingId ||
      other.roomId !== occupant.roomId ||
      other.stayDate !== stayDate
    ) {
      continue;
    }
    if (isAdultAgeTier(other.ageTier)) {
      otherSameRoomAdult = true;
    } else {
      sameRoomMinor = true;
    }
  }
  return sameRoomMinor && !otherSameRoomAdult;
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
 * The first bed in `allowedRooms` on `stayDate` occupied by a DISPLACEABLE
 * provisional booking, in room/bed sort order (issue #1387). Skipped occupants:
 *   - capacity-holding (Held) occupants — never displaced;
 *   - admin-APPROVED allocations (#776 lock) — never displaced;
 *   - an ADULT whose displacement would strand a same-booking minor.
 */
function findDisplaceableProvisionalBed(
  allowedRooms: SortedRoomWithBeds[],
  stayDate: string,
  occupantByKey: Map<string, OccupantInfo>,
): { bed: BedAllocationBed; occupant: OccupantInfo } | null {
  for (const room of allowedRooms) {
    for (const bed of room.beds) {
      const key = occupiedKey(bed.id, stayDate);
      const occupant = occupantByKey.get(key);
      if (!occupant || occupant.holdsCapacity || occupant.isApproved) {
        continue;
      }
      if (
        isAdultAgeTier(occupant.ageTier) &&
        displacingAdultStrandsSameBookingMinor(
          occupantByKey,
          occupant,
          key,
          stayDate,
        )
      ) {
        continue;
      }
      return { bed, occupant };
    }
  }

  return null;
}

/**
 * A genuinely-free bed on `stayDate` to relocate a displaced provisional
 * occupant to, preferring a bed in its current room. When `restrictRoomIds` is
 * given (relocating a provisional MINOR), only beds in those rooms qualify, so
 * the minor keeps a same-booking adult in its room. Returns null when no valid
 * free bed exists (forcing an UNALLOCATE instead of a MOVE). Issue #1387.
 */
function findFreeRelocationBed(
  activeRooms: SortedRoomWithBeds[],
  stayDate: string,
  occupied: Set<string>,
  preferRoomId: string,
  restrictRoomIds?: Set<string>,
): BedAllocationBed | null {
  const orderedRooms = [...activeRooms].sort((a, b) => {
    const aPref = a.id === preferRoomId ? 0 : 1;
    const bPref = b.id === preferRoomId ? 0 : 1;
    return aPref - bPref;
  });

  for (const room of orderedRooms) {
    if (restrictRoomIds && !restrictRoomIds.has(room.id)) {
      continue;
    }
    for (const bed of room.beds) {
      if (!occupied.has(occupiedKey(bed.id, stayDate))) {
        return bed;
      }
    }
  }

  return null;
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

interface DisplacementContext {
  booking: BedAllocationBooking;
  guest: BedAllocationGuest;
  stayDate: string;
  activeRooms: SortedRoomWithBeds[];
  bedRoomIds: Map<string, string>;
  occupied: Set<string>;
  occupantByKey: Map<string, OccupantInfo>;
  allocatedGuestNights: Set<string>;
  allocations: BedAllocationCandidate[];
  existingAdultRooms: Set<string>;
  unallocatedGuestNights: UnallocatedGuestNight[];
  displacementByGuestNight: Map<string, BedAllocationDisplacement>;
}

/**
 * Try to place a still-unallocated capacity-holding guest-night by displacing a
 * provisional occupant (issue #1387). Preference order: relocate the provisional
 * occupant to a free bed (MOVE) over unallocating it (UNALLOCATE); never touch a
 * capacity-holding occupant. Returns true when the held guest was placed. Only
 * ever called during the capacity-holding phase (held bookings are sorted
 * first), so every provisional occupant it sees is a PRE-EXISTING allocation —
 * a real DB row the lifecycle can move or delete.
 */
function tryDisplaceProvisionalForHeldGuest(context: DisplacementContext): boolean {
  const {
    booking,
    guest,
    stayDate,
    activeRooms,
    bedRoomIds,
    occupied,
    occupantByKey,
    allocatedGuestNights,
    allocations,
    existingAdultRooms,
    unallocatedGuestNights,
    displacementByGuestNight,
  } = context;

  let allowedRooms: SortedRoomWithBeds[];
  if (isAdultGuest(guest)) {
    allowedRooms = activeRooms;
  } else {
    const adultRooms = adultRoomsForBookingNight(
      booking,
      stayDate,
      existingAdultRooms,
      allocations,
    );
    if (adultRooms.size === 0) {
      return false;
    }
    allowedRooms = activeRooms.filter((room) => adultRooms.has(room.id));
  }

  const candidate = findDisplaceableProvisionalBed(
    allowedRooms,
    stayDate,
    occupantByKey,
  );
  if (!candidate) {
    return false;
  }

  const { bed: targetBed, occupant } = candidate;
  const targetKey = occupiedKey(targetBed.id, stayDate);
  const fromRoomId = bedRoomIds.get(targetBed.id) ?? occupant.roomId;
  // A provisional MINOR may only be relocated into a room that still has an
  // adult of ITS OWN booking that night; otherwise a MOVE would strand it, so
  // it falls back to UNALLOCATE (removing a minor strands no one). Issue #1387.
  const relocationRooms = isAdultAgeTier(occupant.ageTier)
    ? undefined
    : bookingAdultRoomsFromOccupants(
        occupantByKey,
        occupant.bookingId,
        stayDate,
      );
  const freeBed = findFreeRelocationBed(
    activeRooms,
    stayDate,
    occupied,
    fromRoomId,
    relocationRooms,
  );

  if (freeBed) {
    // MOVE: relocate the provisional occupant to the free bed, then hand the
    // vacated bed to the held guest. The vacated bed stays in `occupied`
    // (transferred to the held guest); the free bed becomes occupied.
    const freeKey = occupiedKey(freeBed.id, stayDate);
    const freeRoomId = bedRoomIds.get(freeBed.id) ?? freeBed.roomId;
    occupied.add(freeKey);
    occupantByKey.set(freeKey, { ...occupant, roomId: freeRoomId });
    occupantByKey.delete(targetKey);
    upsertDisplacement(displacementByGuestNight, {
      type: "MOVE",
      bookingId: occupant.bookingId,
      bookingGuestId: occupant.bookingGuestId,
      stayDate,
      fromBedId: targetBed.id,
      fromRoomId,
      toBedId: freeBed.id,
      toRoomId: freeRoomId,
      displacedByBookingId: booking.id,
    });
  } else {
    // UNALLOCATE: no free bed to relocate to; remove the provisional allocation
    // and hand its bed to the held guest. The bed stays in `occupied`.
    occupantByKey.delete(targetKey);
    upsertDisplacement(displacementByGuestNight, {
      type: "UNALLOCATE",
      bookingId: occupant.bookingId,
      bookingGuestId: occupant.bookingGuestId,
      stayDate,
      fromBedId: targetBed.id,
      fromRoomId,
      displacedByBookingId: booking.id,
    });
  }

  allocatedGuestNights.add(guestNightKey(guest.id, stayDate));
  allocations.push({
    bookingId: booking.id,
    bookingGuestId: guest.id,
    roomId: fromRoomId,
    bedId: targetBed.id,
    stayDate,
    source: "AUTO",
  });
  removeUnallocatedGuestNight(unallocatedGuestNights, guest.id, stayDate);

  return true;
}

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
  const beds = activeRooms.flatMap((room) => room.beds);
  const bedRoomIds = new Map(beds.map((bed) => [bed.id, bed.roomId]));
  const occupied = new Set(
    occupiedBedNights.map((night) =>
      occupiedKey(night.bedId, normalizeStayDate(night.stayDate)),
    ),
  );
  const occupantByKey = new Map<string, OccupantInfo>();
  if (prioritizeCapacityHolding) {
    for (const night of occupiedBedNights) {
      if (!night.bookingId || !night.bookingGuestId) continue;
      occupantByKey.set(
        occupiedKey(night.bedId, normalizeStayDate(night.stayDate)),
        {
          bookingId: night.bookingId,
          bookingGuestId: night.bookingGuestId,
          roomId:
            night.roomId ?? bedRoomIds.get(night.bedId) ?? "",
          stayDate: normalizeStayDate(night.stayDate),
          ageTier: night.ageTier ?? null,
          holdsCapacity: night.holdsCapacity === true,
          isApproved: Boolean(night.approvedAt),
        },
      );
    }
  }
  const displacementByGuestNight = new Map<
    string,
    BedAllocationDisplacement
  >();
  const existingByBookingNight =
    existingAllocationsByBookingNight(occupiedBedNights);
  const allocatedGuestNights = new Set(
    occupiedBedNights
      .filter((night) => night.bookingGuestId)
      .map((night) =>
        guestNightKey(
          night.bookingGuestId as string,
          normalizeStayDate(night.stayDate),
        ),
      ),
  );
  const allocations: BedAllocationCandidate[] = [];
  const unallocatedGuestNights: UnallocatedGuestNight[] = [];
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

  for (const booking of sortedBookings) {
    const roomsForThisBooking = roomsForBooking(activeRooms, booking);

    for (const { stayDate, guests } of bookingStayNights(booking)) {
      const existingAdultRooms = existingAdultRoomIds(
        existingByBookingNight.get(bookingNightKey(booking.id, stayDate)) ?? [],
        guests,
      );
      const unallocatedGuests = guests.filter(
        (guest) => !allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
      );
      if (unallocatedGuests.length === 0) continue;

      const placedWhole = tryAllocateWholeBookingNight(
        booking,
        unallocatedGuests,
        stayDate,
        roomsForThisBooking,
        occupied,
        allocatedGuestNights,
        allocations,
        existingAdultRooms,
      );

      if (!placedWhole) {
        allocateSplitBookingNight(
          booking,
          unallocatedGuests,
          stayDate,
          roomsForThisBooking,
          beds,
          occupied,
          allocatedGuestNights,
          allocations,
          unallocatedGuestNights,
          existingAdultRooms,
        );
      }

      // First-claim displacement (issue #1387): a capacity-holding booking whose
      // guest-night the normal first-fit could not place — because only
      // PROVISIONAL allocations block it — moves a provisional occupant aside
      // (or unallocates it) to claim a bed. Never runs for provisional bookings,
      // and never displaces a capacity-holding occupant.
      if (prioritizeCapacityHolding && booking.holdsCapacity) {
        // Adults-first (issue #1387): displace-in the held booking's adults
        // before its minors so a minor whose only adult also needs displacing
        // still finds a same-booking adult room (via `adultRoomsForBookingNight`,
        // which sees this run's adult allocations). Stable within each tier.
        const stillUnallocated = unallocatedGuests
          .filter(
            (guest) =>
              !allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
          )
          .sort(
            (a, b) => Number(isAdultGuest(b)) - Number(isAdultGuest(a)),
          );
        for (const guest of stillUnallocated) {
          tryDisplaceProvisionalForHeldGuest({
            booking,
            guest,
            stayDate,
            // Lodge isolation (#1387 × multi-lodge): the displacement search —
            // both the displaceable-bed scan and the free-bed relocation target —
            // must run over THIS booking's own lodge rooms, never the pooled
            // all-lodges `activeRooms`. Otherwise a held booking at lodge A could
            // evict a provisional occupant from, or relocate one onto, another
            // lodge's bed (the club-wide auto-allocation pools every lodge's rooms
            // into one planner call).
            activeRooms: roomsForThisBooking,
            bedRoomIds,
            occupied,
            occupantByKey,
            allocatedGuestNights,
            allocations,
            existingAdultRooms,
            unallocatedGuestNights,
            displacementByGuestNight,
          });
        }
      }
    }
  }

  const displacements = [...displacementByGuestNight.values()];
  return displacements.length > 0
    ? { allocations, unallocatedGuestNights, displacements }
    : { allocations, unallocatedGuestNights };
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
