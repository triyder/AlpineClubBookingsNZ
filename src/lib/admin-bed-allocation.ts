import { Prisma, type BedAllocation } from "@prisma/client";
import { clubConfig } from "@/config/club";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { getLodgeCapacityStatus, type LodgeCapacityStatus } from "@/lib/lodge-capacity";
import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationAgeTier,
  type BedAllocationBooking,
  type BedAllocationCandidate,
  type BedAllocationRoom,
  type UnallocatedGuestNight,
} from "@/lib/bed-allocation";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { prisma } from "@/lib/prisma";

const BED_ALLOCATION_SETTINGS_ID = "default";
export const MAX_BED_ALLOCATION_RANGE_NIGHTS = 31;

export class BedAllocationAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "BedAllocationAdminError";
  }
}

export interface BedAllocationDateRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

export interface BedAllocationSettingsPayload {
  autoAllocationEnabled: boolean;
  updatedByMemberId: string | null;
  updatedAt: string | null;
}

export interface AdminBedAllocationWarning {
  id: string;
  // BOOKING_SPLIT is same-night (party split across rooms on one night);
  // ROOM_SWITCH is stay-level (issue #1677) — the booking's room set changes
  // between nights, so someone must move rooms mid-stay.
  type: "BOOKING_SPLIT" | "MINOR_WITHOUT_BOOKING_ADULT" | "ROOM_SWITCH";
  severity: "warning";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface DashboardBooking {
  id: string;
  status: string;
  // Server-computed capacity-holding flag (#1254): status-holding OR a
  // request-converted PENDING booking (accepted-but-unpaid quote / approval).
  holdsCapacity: boolean;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  guests: DashboardGuest[];
  requestedRoom: DashboardRequestedRoom | null;
  // Split-booking group link (#738): set on the provisional non-member child.
  parentBookingId: string | null;
}

interface DashboardGuest {
  id: string;
  bookingId: string;
  name: string;
  ageTier: BedAllocationAgeTier;
  stayStart: string;
  stayEnd: string;
}

interface DashboardAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: BedAllocationAgeTier;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
  // Raw booking status (issue #1251), kept for display/debugging.
  bookingStatus: string;
  // Server-computed "Held" vs "Provisional" signal (#1254). Holding is no longer
  // a pure function of status (an accepted-but-unpaid quote is PENDING but holds),
  // so the board reads this precomputed flag from bookingHoldsCapacity().
  holdsCapacity: boolean;
}

interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: BedAllocationAgeTier;
  memberName: string;
  stayDate: string;
}

interface DashboardRequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

export interface BedAllocationDashboardPayload {
  settings: BedAllocationSettingsPayload;
  range: {
    fromDate: string;
    toDate: string;
  };
  rooms: DashboardRoom[];
  bookings: DashboardBooking[];
  allocations: DashboardAllocation[];
  unallocatedGuestNights: DashboardGuestNight[];
  suggestedAllocations: BedAllocationCandidate[];
  suggestedUnallocatedGuestNights: UnallocatedGuestNight[];
  warnings: AdminBedAllocationWarning[];
  // Stay window of a deep-linked focused booking (?bookingId=…) when it falls
  // outside the current date range and is therefore absent from `bookings`
  // (#1302). Lets the board snap Date In / Date Out onto the booking so its chip
  // becomes visible. Null when no booking is focused, when it is already in
  // range, or when it is not an allocatable booking.
  focusedBooking: { id: string; checkIn: string; checkOut: string } | null;
}

export interface RoomsAndBedsConfigurationPayload {
  rooms: DashboardRoom[];
  capacity: LodgeCapacityStatus;
  canImportFromConfig: boolean;
  configBeds: Array<{
    id: string;
    name: string;
    capacity: number;
    type: string;
  }>;
}

export interface ImportRoomsAndBedsResult {
  createdRoomCount: number;
  createdBedCount: number;
  rooms: DashboardRoom[];
}

type BedAllocationDb = typeof prisma | Prisma.TransactionClient;

type DashboardBookingRecord = Awaited<
  ReturnType<typeof loadBookingRecords>
>[number];

type DashboardAllocationRecord = Awaited<
  ReturnType<typeof loadAllocationRecords>
>[number];

export function parseBedAllocationDateRange(input: {
  from?: string | null;
  to?: string | null;
}): BedAllocationDateRange {
  const fromDate = input.from || formatDateOnly(getTodayDateOnly());
  if (!isDateOnlyString(fromDate)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }

  const from = parseDateOnly(fromDate);
  const toDate = input.to || formatDateOnly(addDaysDateOnly(from, 7));
  if (!isDateOnlyString(toDate)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const to = parseDateOnly(toDate);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nights = eachDateOnlyInRange(from, to).length;
  if (nights > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
      400,
    );
  }

  return { from, to, fromDate, toDate };
}

async function getBedAllocationSettings(
  db: BedAllocationDb = prisma,
  // Lodge scope (lodge-scoping contract): the lodge's own row (id =
  // lodgeId) wins; else the legacy "default" row applies when unlinked or
  // soft-linked to this lodge; else code defaults.
  lodgeId?: string | null,
): Promise<BedAllocationSettingsPayload> {
  if (lodgeId && lodgeId !== BED_ALLOCATION_SETTINGS_ID) {
    const ownRow = await db.bedAllocationSettings.findUnique({
      where: { id: lodgeId },
    });
    if (ownRow) {
      return {
        autoAllocationEnabled: ownRow.autoAllocationEnabled,
        updatedByMemberId: ownRow.updatedByMemberId,
        updatedAt: ownRow.updatedAt.toISOString(),
      };
    }
  }
  const record = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });
  if (record && lodgeId && record.lodgeId && record.lodgeId !== lodgeId) {
    return {
      autoAllocationEnabled: true,
      updatedByMemberId: null,
      updatedAt: null,
    };
  }

  return {
    autoAllocationEnabled: record?.autoAllocationEnabled ?? true,
    updatedByMemberId: record?.updatedByMemberId ?? null,
    updatedAt: record?.updatedAt.toISOString() ?? null,
  };
}

export async function updateBedAllocationSettings(input: {
  autoAllocationEnabled: boolean;
  updatedByMemberId: string;
  db?: BedAllocationDb;
  // Lodge scope: the legacy "default" row keeps serving the lodge it was
  // soft-linked to (and single-lodge clubs); other lodges get their own
  // row keyed by lodge id. An unlinked legacy row is claimed on write.
  lodgeId?: string | null;
}): Promise<BedAllocationSettingsPayload> {
  const db = input.db ?? prisma;
  const legacy = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });
  const targetsLegacyRow =
    !input.lodgeId ||
    !legacy ||
    legacy.lodgeId === null ||
    legacy.lodgeId === input.lodgeId;
  const targetId = targetsLegacyRow
    ? BED_ALLOCATION_SETTINGS_ID
    : input.lodgeId!;

  const record = await db.bedAllocationSettings.upsert({
    where: { id: targetId },
    create: {
      id: targetId,
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
      lodgeId: input.lodgeId ?? null,
    },
    update: {
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
      ...(input.lodgeId && (!legacy || legacy.lodgeId === null) && targetsLegacyRow
        ? { lodgeId: input.lodgeId }
        : {}),
    },
  });

  return {
    autoAllocationEnabled: record.autoAllocationEnabled,
    updatedByMemberId: record.updatedByMemberId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function listBedAllocationRooms(
  db: BedAllocationDb = prisma,
  lodgeId?: string,
) {
  return db.lodgeRoom.findMany({
    // Null-tolerant filter: rooms without a lodgeId (pre-backfill or written
    // by a draining old colour during the expand deploy) show under every
    // lodge.
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    include: {
      beds: {
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });
}

export async function getRoomsAndBedsConfiguration(
  db: BedAllocationDb = prisma,
  requestedLodgeId?: string,
): Promise<RoomsAndBedsConfigurationPayload> {
  const lodgeId = requestedLodgeId ?? (await getDefaultLodgeId(db));
  const rooms = await listBedAllocationRooms(db, lodgeId);
  const capacity = await getLodgeCapacityStatus(lodgeId, db);
  // Import seeds the club's first lodge only, so the offer keys off the
  // whole tables being empty, not just the selected lodge's slice.
  const [totalRoomCount, totalBedCount] = await Promise.all([
    db.lodgeRoom.count(),
    db.lodgeBed.count(),
  ]);

  return {
    rooms: serializeRooms(rooms),
    capacity,
    canImportFromConfig: totalRoomCount === 0 && totalBedCount === 0,
    configBeds: clubConfig.beds.map((bed) => ({
      id: bed.id,
      name: bed.name,
      capacity: bed.capacity,
      type: bed.type,
    })),
  };
}

function uniqueConfigRoomName(
  bed: (typeof clubConfig.beds)[number],
  seenNames: Set<string>,
) {
  const baseName = bed.name.trim() || bed.id.trim() || "Imported Room";
  if (!seenNames.has(baseName)) {
    seenNames.add(baseName);
    return baseName;
  }

  const fallbackName = `${baseName} (${bed.id})`;
  seenNames.add(fallbackName);
  return fallbackName;
}

async function assertRoomBedTablesEmpty(db: BedAllocationDb) {
  const [roomCount, bedCount] = await Promise.all([
    db.lodgeRoom.count(),
    db.lodgeBed.count(),
  ]);

  if (roomCount > 0 || bedCount > 0) {
    throw new BedAllocationAdminError(
      "Rooms and beds have already been configured.",
      409,
    );
  }
}

export async function importRoomsAndBedsFromClubConfig(input: {
  db?: BedAllocationDb;
} = {}): Promise<ImportRoomsAndBedsResult> {
  if (!input.db) {
    return prisma.$transaction((tx) =>
      importRoomsAndBedsFromClubConfig({ db: tx }),
    );
  }

  const db = input.db ?? prisma;
  await assertRoomBedTablesEmpty(db);

  const lodgeId = await getDefaultLodgeId(db);
  const seenNames = new Set<string>();
  let createdRoomCount = 0;
  let createdBedCount = 0;

  for (const [roomIndex, configBed] of clubConfig.beds.entries()) {
    const room = await db.lodgeRoom.create({
      data: {
        name: uniqueConfigRoomName(configBed, seenNames),
        sortOrder: roomIndex + 1,
        active: true,
        notes: `${configBed.type} room imported from club config.`,
        lodgeId,
      },
    });
    createdRoomCount += 1;

    await db.lodgeBed.createMany({
      data: Array.from({ length: configBed.capacity }, (_, bedIndex) => ({
        roomId: room.id,
        name:
          configBed.capacity === 1
            ? configBed.name
            : `Bed ${bedIndex + 1}`,
        sortOrder: bedIndex + 1,
        active: true,
      })),
    });
    createdBedCount += configBed.capacity;
  }

  const rooms = await listBedAllocationRooms(db);
  return {
    createdRoomCount,
    createdBedCount,
    rooms: serializeRooms(rooms),
  };
}

export async function createBedAllocationRoom(input: {
  name: string;
  sortOrder?: number;
  active?: boolean;
  notes?: string | null;
  lodgeId?: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  const lodgeId = input.lodgeId ?? (await getDefaultLodgeId(db));
  const name = input.name.trim();
  // Per-lodge uniqueness with null tolerance: a null-lodge row (pre-backfill
  // or draining old colour) is visible at every lodge, so it clashes here.
  const clash = await db.lodgeRoom.findFirst({
    where: { name, ...lodgeNullTolerantScope(lodgeId) },
    select: { id: true },
  });
  if (clash) {
    throw new BedAllocationAdminError(
      `A room named "${name}" already exists at this lodge.`,
      409,
    );
  }
  return db.lodgeRoom.create({
    data: {
      name,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
      notes: input.notes?.trim() || null,
      lodgeId,
    },
  });
}

export const MAX_BULK_ROOMS = 50;
export const MAX_BULK_BEDS_PER_ROOM = 20;

/**
 * Seed a lodge with `roomCount` rooms of `bedsPerRoom` beds each
 * ("<prefix> 1..N" / "Bed 1..M"), transactionally (ADR-003 bulk seeding).
 * Room names are unique per lodge (null-lodge rows clash at every lodge
 * until the contract release), so a clashing prefix rejects the whole
 * batch rather than half-applying.
 */
export async function createBedAllocationRoomsBulk(input: {
  roomCount: number;
  bedsPerRoom: number;
  namePrefix?: string;
  lodgeId?: string;
  db?: BedAllocationDb;
}): Promise<{ createdRoomCount: number; createdBedCount: number }> {
  if (!input.db) {
    return prisma.$transaction((tx) =>
      createBedAllocationRoomsBulk({ ...input, db: tx }),
    );
  }
  const db = input.db;

  if (input.roomCount < 1 || input.roomCount > MAX_BULK_ROOMS) {
    throw new BedAllocationAdminError(
      `Room count must be between 1 and ${MAX_BULK_ROOMS}.`,
      400,
    );
  }
  if (input.bedsPerRoom < 0 || input.bedsPerRoom > MAX_BULK_BEDS_PER_ROOM) {
    throw new BedAllocationAdminError(
      `Beds per room must be between 0 and ${MAX_BULK_BEDS_PER_ROOM}.`,
      400,
    );
  }

  const namePrefix = input.namePrefix?.trim() || "Room";
  const lodgeId = input.lodgeId ?? (await getDefaultLodgeId(db));
  const names = Array.from(
    { length: input.roomCount },
    (_, index) => `${namePrefix} ${index + 1}`,
  );

  const clash = await db.lodgeRoom.findFirst({
    where: { name: { in: names }, ...lodgeNullTolerantScope(lodgeId) },
    select: { name: true },
  });
  if (clash) {
    throw new BedAllocationAdminError(
      `A room named "${clash.name}" already exists at this lodge. Choose a different name prefix.`,
      409,
    );
  }

  const existingCount = await db.lodgeRoom.count({
    where: lodgeNullTolerantScope(lodgeId),
  });

  let createdBedCount = 0;
  for (const [index, name] of names.entries()) {
    const room = await db.lodgeRoom.create({
      data: {
        name,
        sortOrder: existingCount + index + 1,
        active: true,
        lodgeId,
      },
    });
    if (input.bedsPerRoom > 0) {
      await db.lodgeBed.createMany({
        data: Array.from({ length: input.bedsPerRoom }, (_, bedIndex) => ({
          roomId: room.id,
          name: `Bed ${bedIndex + 1}`,
          sortOrder: bedIndex + 1,
          active: true,
        })),
      });
      createdBedCount += input.bedsPerRoom;
    }
  }

  return {
    createdRoomCount: names.length,
    createdBedCount,
  };
}

export async function updateBedAllocationRoom(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  notes?: string | null;
  db?: BedAllocationDb;
}) {
  const data: Prisma.LodgeRoomUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.active !== undefined) data.active = input.active;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

  return (input.db ?? prisma).lodgeRoom.update({
    where: { id: input.id },
    data,
  });
}

export async function createBedAllocationBed(input: {
  roomId: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
  db?: BedAllocationDb;
}) {
  return (input.db ?? prisma).lodgeBed.create({
    data: {
      roomId: input.roomId,
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });
}

export async function updateBedAllocationBed(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  if (input.active === false) {
    await assertNoFutureBedAllocations({
      bedId: input.id,
      db,
      action: "deactivate",
    });
  }

  const data: Prisma.LodgeBedUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.active !== undefined) data.active = input.active;

  return db.lodgeBed.update({
    where: { id: input.id },
    data,
  });
}

async function assertNoFutureBedAllocations(input: {
  bedId: string;
  db: BedAllocationDb;
  action: "deactivate" | "delete";
}) {
  const blockingAllocations = await input.db.bedAllocation.findMany({
    where: {
      bedId: input.bedId,
      stayDate: { gte: getTodayDateOnly() },
    },
    select: { stayDate: true },
    orderBy: { stayDate: "asc" },
  });

  if (blockingAllocations.length === 0) {
    return;
  }

  const blockingDates = [
    ...new Set(
      blockingAllocations.map((allocation) =>
        formatDateOnly(allocation.stayDate),
      ),
    ),
  ];

  throw new BedAllocationAdminError(
    `Cannot ${input.action} this bed while future allocations exist on ${blockingDates.join(", ")}. Clear those dates on the bed allocation page first.`,
    409,
  );
}

export async function deleteBedAllocationBed(input: {
  id: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  await assertNoFutureBedAllocations({
    bedId: input.id,
    db,
    action: "delete",
  });

  return db.lodgeBed.delete({
    where: { id: input.id },
  });
}

function memberName(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name || member.email || "Unknown member";
}

function guestName(guest: { firstName: string; lastName: string }) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ");
}

function overlapsDateRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationDateRange,
) {
  return stayStart < range.to && stayEnd > range.from;
}

function clampGuestToRange(
  guest: { stayStart: Date; stayEnd: Date },
  range: BedAllocationDateRange,
) {
  return {
    stayStart: guest.stayStart > range.from ? guest.stayStart : range.from,
    stayEnd: guest.stayEnd < range.to ? guest.stayEnd : range.to,
  };
}

async function loadBookingRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      checkIn: { lt: range.to },
      checkOut: { gt: range.from },
      guests: {
        some: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
        },
      },
      // Null-tolerant: bookings still missing a lodgeId (expand-release
      // tolerance) show on every lodge's board.
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      requestedRoomId: true,
      parentBookingId: true,
      // Whether this booking is the converted booking of a BookingRequest — an
      // accepted-but-unpaid quote / approved request holds capacity even while
      // PENDING (#1254), which the Held/Provisional badge must reflect.
      originBookingRequest: { select: { id: true } },
      requestedRoom: {
        select: {
          id: true,
          name: true,
          active: true,
        },
      },
      member: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      guests: {
        where: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
        },
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function loadAllocationRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: range.from,
        lt: range.to,
      },
      // Allocations follow their bed's room; rooms without a lodgeId
      // (expand-release tolerance) show on every lodge's board.
      ...(lodgeId ? { room: lodgeNullTolerantScope(lodgeId) } : {}),
    },
    include: {
      booking: {
        select: {
          status: true,
          // Accepted-but-unpaid quote holds capacity while PENDING (#1254).
          originBookingRequest: { select: { id: true } },
        },
      },
      bookingGuest: {
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
        },
      },
      room: {
        select: {
          id: true,
          name: true,
        },
      },
      bed: {
        select: {
          id: true,
          name: true,
        },
      },
      approvedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: [
      { stayDate: "asc" },
      { room: { sortOrder: "asc" } },
      { bed: { sortOrder: "asc" } },
      { id: "asc" },
    ],
  });
}

function serializeRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    notes: room.notes,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  }));
}

function serializeBookings(
  bookings: DashboardBookingRecord[],
): DashboardBooking[] {
  return bookings.map((booking) => ({
    id: booking.id,
    status: booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: booking.status,
      isRequestConverted: Boolean(booking.originBookingRequest),
    }),
    createdAt: booking.createdAt.toISOString(),
    checkIn: formatDateOnly(booking.checkIn),
    checkOut: formatDateOnly(booking.checkOut),
    memberName: memberName(booking.member),
    guests: booking.guests.map((guest) => ({
      id: guest.id,
      bookingId: guest.bookingId,
      name: guestName(guest),
      ageTier: guest.ageTier,
      stayStart: formatDateOnly(guest.stayStart),
      stayEnd: formatDateOnly(guest.stayEnd),
    })),
    requestedRoom: booking.requestedRoom,
    parentBookingId: booking.parentBookingId,
  }));
}

function serializeAllocations(
  allocations: DashboardAllocationRecord[],
): DashboardAllocation[] {
  return allocations.map((allocation) => ({
    id: allocation.id,
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    guestName: guestName(allocation.bookingGuest),
    guestAgeTier: allocation.bookingGuest.ageTier,
    roomId: allocation.roomId,
    roomName: allocation.room.name,
    bedId: allocation.bedId,
    bedName: allocation.bed.name,
    stayDate: formatDateOnly(allocation.stayDate),
    source: allocation.source,
    approvedAt: allocation.approvedAt?.toISOString() ?? null,
    approvedByName: allocation.approvedBy
      ? memberName(allocation.approvedBy)
      : null,
    bookingStatus: allocation.booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: allocation.booking.status,
      isRequestConverted: Boolean(allocation.booking.originBookingRequest),
    }),
  }));
}

function buildGuestNightRows(
  bookings: DashboardBookingRecord[],
  range: BedAllocationDateRange,
): DashboardGuestNight[] {
  const rows: DashboardGuestNight[] = [];

  for (const booking of bookings) {
    const bookingMemberName = memberName(booking.member);

    for (const guest of booking.guests) {
      const clamped = clampGuestToRange(guest, range);

      for (const date of eachDateOnlyInRange(clamped.stayStart, clamped.stayEnd)) {
        rows.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          guestName: guestName(guest),
          guestAgeTier: guest.ageTier,
          memberName: bookingMemberName,
          stayDate: formatDateOnly(date),
        });
      }
    }
  }

  return rows;
}

function guestNightKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

function candidateGuestBookings(
  bookings: DashboardBookingRecord[],
  guestNights: DashboardGuestNight[],
): BedAllocationBooking[] {
  const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
  const guestsByBooking = new Map<string, BedAllocationBooking["guests"]>();

  for (const guestNight of guestNights) {
    const booking = bookingById.get(guestNight.bookingId);
    if (!booking) continue;

    const stayStart = parseDateOnly(guestNight.stayDate);
    const stayEnd = addDaysDateOnly(stayStart, 1);
    const guests = guestsByBooking.get(booking.id) ?? [];

    guests.push({
      id: guestNight.bookingGuestId,
      bookingId: booking.id,
      ageTier: guestNight.guestAgeTier,
      stayStart,
      stayEnd,
    });
    guestsByBooking.set(booking.id, guests);
  }

  return [...guestsByBooking.entries()]
    .map(([bookingId, guests]): BedAllocationBooking | null => {
      const booking = bookingById.get(bookingId);
      if (!booking) return null;
      return {
        id: booking.id,
        createdAt: booking.createdAt,
        lodgeId: booking.lodgeId,
        requestedRoomId: booking.requestedRoomId,
        guests,
      };
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));
}

function buildPlannerRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    lodgeId: room.lodgeId,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];
}

// test seam
export function buildBedAllocationWarnings(input: {
  allocations: DashboardAllocation[];
}): AdminBedAllocationWarning[] {
  const warnings: AdminBedAllocationWarning[] = [];
  const allocationsByBookingNight = new Map<string, DashboardAllocation[]>();

  for (const allocation of input.allocations) {
    const key = `${allocation.bookingId}:${allocation.stayDate}`;
    const group = allocationsByBookingNight.get(key) ?? [];
    group.push(allocation);
    allocationsByBookingNight.set(key, group);
  }

  for (const group of allocationsByBookingNight.values()) {
    const first = group[0];
    const roomIds = new Set(group.map((allocation) => allocation.roomId));

    if (roomIds.size > 1) {
      warnings.push({
        id: `BOOKING_SPLIT:${first.bookingId}:${first.stayDate}`,
        type: "BOOKING_SPLIT",
        severity: "warning",
        bookingId: first.bookingId,
        stayDate: first.stayDate,
        message: `Booking ${first.bookingId} is split across ${roomIds.size} rooms on ${first.stayDate}.`,
      });
    }

    for (const allocation of group) {
      if (allocation.guestAgeTier === "ADULT") continue;

      const hasBookingAdultInRoom = group.some(
        (candidate) =>
          candidate.roomId === allocation.roomId &&
          candidate.guestAgeTier === "ADULT",
      );

      if (!hasBookingAdultInRoom) {
        warnings.push({
          id: `MINOR_WITHOUT_BOOKING_ADULT:${allocation.bookingGuestId}:${allocation.stayDate}`,
          type: "MINOR_WITHOUT_BOOKING_ADULT",
          severity: "warning",
          bookingId: allocation.bookingId,
          bookingGuestId: allocation.bookingGuestId,
          stayDate: allocation.stayDate,
          roomId: allocation.roomId,
          message: `${allocation.guestName} is allocated without a booking adult in ${allocation.roomName} on ${allocation.stayDate}.`,
        });
      }
    }
  }

  // Stay-level room continuity (issue #1677): warn when a booking's set of
  // rooms changes between nights — someone has to move rooms mid-stay. This is
  // distinct from BOOKING_SPLIT, which flags a party split across rooms on ONE
  // night; a booking split identically every night raises no ROOM_SWITCH.
  const nightRoomsByBooking = new Map<string, Map<string, Set<string>>>();
  for (const allocation of input.allocations) {
    let nights = nightRoomsByBooking.get(allocation.bookingId);
    if (!nights) {
      nights = new Map();
      nightRoomsByBooking.set(allocation.bookingId, nights);
    }
    let roomIds = nights.get(allocation.stayDate);
    if (!roomIds) {
      roomIds = new Set();
      nights.set(allocation.stayDate, roomIds);
    }
    roomIds.add(allocation.roomId);
  }
  for (const [bookingId, nights] of nightRoomsByBooking) {
    const sortedNights = [...nights.keys()].sort();
    if (sortedNights.length < 2) continue;
    const roomKeyForNight = (night: string) =>
      [...(nights.get(night) ?? [])].sort().join(",");
    const firstKey = roomKeyForNight(sortedNights[0]);
    const switchNight = sortedNights.find(
      (night) => roomKeyForNight(night) !== firstKey,
    );
    if (!switchNight) continue;
    const roomCount = new Set(
      sortedNights.flatMap((night) => [...(nights.get(night) ?? [])]),
    ).size;
    warnings.push({
      id: `ROOM_SWITCH:${bookingId}`,
      type: "ROOM_SWITCH",
      severity: "warning",
      bookingId,
      stayDate: switchNight,
      message: `Booking ${bookingId} changes rooms mid-stay (from ${switchNight}; ${roomCount} rooms across ${sortedNights.length} nights).`,
    });
  }

  return warnings;
}

export async function getBedAllocationDashboard(input: {
  range: BedAllocationDateRange;
  // Scope the whole board — rooms, bookings, allocations, and therefore the
  // first-fit suggestions — to one lodge (ADR-003). Omitted = club-wide,
  // preserving single-lodge behaviour.
  lodgeId?: string;
  // Deep-linked focused booking (?bookingId=…). When set and out of range, the
  // response carries its stay window so the board can snap onto it (#1302).
  bookingId?: string | null;
  db?: BedAllocationDb;
}): Promise<BedAllocationDashboardPayload> {
  const db = input.db ?? prisma;
  const [settings, rooms, bookings, allocationRecords] = await Promise.all([
    getBedAllocationSettings(db, input.lodgeId),
    listBedAllocationRooms(db, input.lodgeId),
    loadBookingRecords(input.range, db, input.lodgeId),
    loadAllocationRecords(input.range, db, input.lodgeId),
  ]);
  const serializedAllocations = serializeAllocations(allocationRecords);
  const allGuestNights = buildGuestNightRows(bookings, input.range);
  const allocatedGuestNights = new Set(
    serializedAllocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, allocation.stayDate),
    ),
  );
  const unallocatedGuestNights = allGuestNights.filter(
    (guestNight) =>
      !allocatedGuestNights.has(
        guestNightKey(guestNight.bookingGuestId, guestNight.stayDate),
      ),
  );
  const plannerRooms = buildPlannerRooms(rooms);
  const plannerBookings = candidateGuestBookings(bookings, unallocatedGuestNights);
  const plan = settings.autoAllocationEnabled
    ? buildFirstFitBedAllocationPlan({
        enabled: true,
        rooms: plannerRooms,
        bookings: plannerBookings,
        occupiedBedNights: serializedAllocations.map((allocation) => ({
          bedId: allocation.bedId,
          bookingId: allocation.bookingId,
          bookingGuestId: allocation.bookingGuestId,
          roomId: allocation.roomId,
          stayDate: allocation.stayDate,
          ageTier: allocation.guestAgeTier,
        })),
      })
    : { allocations: [], unallocatedGuestNights: [] };

  // Resolve a deep-linked focused booking that falls outside the current range
  // (#1302). It is absent from `bookings` (range-filtered), so the client cannot
  // snap onto it without its stay window. Look it up only when it is not already
  // in range, and only if it is an allocatable, non-deleted booking.
  let focusedBooking: BedAllocationDashboardPayload["focusedBooking"] = null;
  if (input.bookingId && !bookings.some((booking) => booking.id === input.bookingId)) {
    const found = await db.booking.findFirst({
      where: {
        id: input.bookingId,
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      },
      select: { id: true, checkIn: true, checkOut: true },
    });
    if (found) {
      focusedBooking = {
        id: found.id,
        checkIn: formatDateOnly(found.checkIn),
        checkOut: formatDateOnly(found.checkOut),
      };
    }
  }

  return {
    settings,
    range: {
      fromDate: input.range.fromDate,
      toDate: input.range.toDate,
    },
    rooms: serializeRooms(rooms),
    bookings: serializeBookings(bookings),
    allocations: serializedAllocations,
    unallocatedGuestNights,
    suggestedAllocations: plan.allocations,
    suggestedUnallocatedGuestNights: plan.unallocatedGuestNights,
    warnings: buildBedAllocationWarnings({ allocations: serializedAllocations }),
    focusedBooking,
  };
}

export async function runAutoBedAllocation(input: {
  range: BedAllocationDateRange;
  // Auto-allocation follows the board's lodge scope, so a suggestion can
  // never place a guest into another lodge's bed.
  lodgeId?: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  const dashboard = await getBedAllocationDashboard({
    range: input.range,
    lodgeId: input.lodgeId,
    db,
  });

  if (!dashboard.settings.autoAllocationEnabled) {
    throw new BedAllocationAdminError(
      "Auto allocation is disabled; use manual allocation.",
      409,
    );
  }

  if (dashboard.suggestedAllocations.length === 0) {
    return { count: 0 };
  }

  return db.bedAllocation.createMany({
    data: dashboard.suggestedAllocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: parseDateOnly(allocation.stayDate),
      source: "AUTO" as const,
    })),
    skipDuplicates: true,
  });
}

async function assertGuestAndBedForAllocation(input: {
  bookingGuestId: string;
  bedId: string;
  db: BedAllocationDb;
}) {
  const [guest, bed] = await Promise.all([
    input.db.bookingGuest.findUnique({
      where: { id: input.bookingGuestId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            lodgeId: true,
          },
        },
      },
    }),
    input.db.lodgeBed.findUnique({
      where: { id: input.bedId },
      include: { room: true },
    }),
  ]);

  if (!guest) {
    throw new BedAllocationAdminError("Guest not found", 404);
  }
  if (!bed || bed.active === false || bed.room.active === false) {
    throw new BedAllocationAdminError("Active bed not found", 404);
  }
  if (guest.booking.deletedAt) {
    throw new BedAllocationAdminError("Cannot allocate deleted booking", 409);
  }
  if (
    !BED_ALLOCATABLE_BOOKING_STATUSES.includes(
      guest.booking.status as (typeof BED_ALLOCATABLE_BOOKING_STATUSES)[number],
    )
  ) {
    throw new BedAllocationAdminError(
      "Booking status is not allocatable",
      409,
    );
  }
  // Lodge-scoping contract: a booking's bed allocations must belong to the
  // booking's lodge. Rows still missing a lodgeId (expand-release tolerance)
  // pass on either side.
  if (
    guest.booking.lodgeId &&
    bed.room.lodgeId &&
    guest.booking.lodgeId !== bed.room.lodgeId
  ) {
    throw new BedAllocationAdminError(
      "Bed belongs to a different lodge than the booking",
      409,
    );
  }

  return { guest, bed };
}

function guestIsStayingOn(
  guest: { stayStart: Date; stayEnd: Date },
  stayDate: Date,
): boolean {
  return overlapsDateRange(guest.stayStart, guest.stayEnd, {
    from: stayDate,
    to: addDaysDateOnly(stayDate, 1),
    fromDate: formatDateOnly(stayDate),
    toDate: formatDateOnly(addDaysDateOnly(stayDate, 1)),
  });
}

async function assertManualAllocationInput(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: Date;
  db: BedAllocationDb;
}) {
  const { guest, bed } = await assertGuestAndBedForAllocation(input);

  if (!guestIsStayingOn(guest, input.stayDate)) {
    throw new BedAllocationAdminError(
      "Guest is not staying on the selected date",
      400,
    );
  }

  return { guest, bed };
}

export async function manuallyAllocateBed(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: string;
  db?: BedAllocationDb;
}) {
  if (!isDateOnlyString(input.stayDate)) {
    throw new BedAllocationAdminError("Invalid stay date", 400);
  }

  const db = input.db ?? prisma;
  const stayDate = parseDateOnly(input.stayDate);
  const { guest, bed } = await assertManualAllocationInput({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    stayDate,
    db,
  });

  try {
    return await db.bedAllocation.upsert({
      where: {
        bookingGuestId_stayDate: {
          bookingGuestId: input.bookingGuestId,
          stayDate,
        },
      },
      create: {
        bookingId: guest.bookingId,
        bookingGuestId: guest.id,
        roomId: bed.roomId,
        bedId: bed.id,
        stayDate,
        source: "MANUAL",
      },
      update: {
        roomId: bed.roomId,
        bedId: bed.id,
        source: "MANUAL",
        approvedAt: null,
        approvedByMemberId: null,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new BedAllocationAdminError(
        "That bed is already allocated for the selected date.",
        409,
      );
    }
    throw error;
  }
}

interface BulkAllocationConflict {
  stayDate: string;
  reason: "BED_TAKEN";
}

export interface BulkAllocationResult {
  allocations: BedAllocation[];
  conflicts: BulkAllocationConflict[];
  skipped: string[];
}

/**
 * Allocates a guest to the same bed across several nights in one pass, used
 * for "drop a guest's full stay onto a bed" board interactions. Each night is
 * upserted independently so a bed already taken by another guest on one
 * night (a 409 in the single-night endpoint) is reported as a conflict
 * instead of aborting the nights that succeeded.
 */
export async function manuallyAllocateBedForNights(input: {
  bookingGuestId: string;
  bedId: string;
  stayDates: string[];
  db?: BedAllocationDb;
}): Promise<BulkAllocationResult> {
  if (input.stayDates.length === 0) {
    throw new BedAllocationAdminError(
      "At least one stay date is required",
      400,
    );
  }
  if (input.stayDates.length > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Cannot allocate more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights at once`,
      400,
    );
  }
  for (const stayDate of input.stayDates) {
    if (!isDateOnlyString(stayDate)) {
      throw new BedAllocationAdminError("Invalid stay date", 400);
    }
  }

  const db = input.db ?? prisma;
  const { guest, bed } = await assertGuestAndBedForAllocation({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    db,
  });

  const allocations: BedAllocation[] = [];
  const conflicts: BulkAllocationConflict[] = [];
  const skipped: string[] = [];

  for (const stayDateStr of [...new Set(input.stayDates)].sort()) {
    const stayDate = parseDateOnly(stayDateStr);
    if (!guestIsStayingOn(guest, stayDate)) {
      skipped.push(stayDateStr);
      continue;
    }

    try {
      const allocation = await db.bedAllocation.upsert({
        where: {
          bookingGuestId_stayDate: {
            bookingGuestId: input.bookingGuestId,
            stayDate,
          },
        },
        create: {
          bookingId: guest.bookingId,
          bookingGuestId: guest.id,
          roomId: bed.roomId,
          bedId: bed.id,
          stayDate,
          source: "MANUAL",
        },
        update: {
          roomId: bed.roomId,
          bedId: bed.id,
          source: "MANUAL",
          approvedAt: null,
          approvedByMemberId: null,
        },
      });
      allocations.push(allocation);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        conflicts.push({ stayDate: stayDateStr, reason: "BED_TAKEN" });
        continue;
      }
      throw error;
    }
  }

  return { allocations, conflicts, skipped };
}

export async function deleteBedAllocation(input: {
  id: string;
  db?: BedAllocationDb;
}) {
  return (input.db ?? prisma).bedAllocation.delete({
    where: { id: input.id },
  });
}

/**
 * Whether an admin has confirmed (locked) the bed allocation for a booking.
 *
 * Issue #776: members may set/clear their requested room until the lodge
 * confirms beds. The lock signal is the presence of at least one approved
 * BedAllocation row for the booking — `approveBedAllocations` stamps
 * `approvedAt`/`approvedByMemberId` when an admin explicitly confirms beds.
 * Unapproved (auto-suggested or pending manual) allocations do not lock it.
 */
export async function isBookingBedAllocationLocked(input: {
  bookingId: string;
  db?: BedAllocationDb;
}): Promise<boolean> {
  const db = input.db ?? prisma;
  const approved = await db.bedAllocation.findFirst({
    where: {
      bookingId: input.bookingId,
      approvedAt: { not: null },
    },
    select: { id: true },
  });
  return approved !== null;
}

export async function approveBedAllocations(input: {
  approvedByMemberId: string;
  allocationIds?: string[];
  range?: BedAllocationDateRange;
  // Range approval follows the board's lodge scope so approving one lodge's
  // board never approves another lodge's pending allocations.
  lodgeId?: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  const where: Prisma.BedAllocationWhereInput = {
    approvedAt: null,
  };

  if (input.allocationIds?.length) {
    where.id = { in: input.allocationIds };
  } else if (input.range) {
    where.stayDate = {
      gte: input.range.from,
      lt: input.range.to,
    };
    if (input.lodgeId) {
      where.room = lodgeNullTolerantScope(input.lodgeId);
    }
  } else {
    throw new BedAllocationAdminError(
      "Select allocations or provide a date range to approve.",
      400,
    );
  }

  return db.bedAllocation.updateMany({
    where,
    data: {
      approvedAt: new Date(),
      approvedByMemberId: input.approvedByMemberId,
    },
  });
}
