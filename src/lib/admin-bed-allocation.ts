import {
  Prisma,
  type BedAllocation,
  type BedType,
  type LodgeBed,
  type LodgeRoom,
} from "@prisma/client";
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
  // Descriptive bed type (#1675); does not change capacity (1/bed/night).
  bedType: BedType;
  // Pairing label; two beds max per (room, bunkGroup), one top + one bottom.
  bunkGroup: string | null;
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

// ---------------------------------------------------------------------------
// Bunk-pairing validation (#1675)
//
// A bunkGroup labels two physical beds stacked as a bunk: at most two beds may
// share one (roomId, bunkGroup), and they must be one BUNK_TOP + one
// BUNK_BOTTOM. A bunk type without a group is allowed (an unpaired bunk — the
// UI surfaces it as a soft warning); a group without a bunk type is rejected.
// These rules are enforced here rather than in the schema because a
// "<=2 per group, one of each type" invariant cannot be a plain unique index,
// and raw-SQL partial indexes are out of scope for this change.
// ---------------------------------------------------------------------------

function isBunkBedType(bedType: BedType): boolean {
  return bedType === "BUNK_TOP" || bedType === "BUNK_BOTTOM";
}

function bedTypeLabel(bedType: BedType): string {
  switch (bedType) {
    case "BUNK_TOP":
      return "bunk-top";
    case "BUNK_BOTTOM":
      return "bunk-bottom";
    case "DOUBLE":
      return "double";
    default:
      return "single";
  }
}

function normalizeBunkGroup(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Human list of quoted bed names, e.g. `"Old Top"` or `"Old Top" and "Old
// Bottom"`, used when naming the deactivated bed(s) that hold a bunk slot.
function quotedBedNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

function assertBunkGroupTypeConsistency(
  bedType: BedType,
  bunkGroup: string | null,
) {
  if (bunkGroup && !isBunkBedType(bedType)) {
    throw new BedAllocationAdminError(
      "A bunk group needs a bunk-top or bunk-bottom bed type.",
      400,
    );
  }
}

// Serialise concurrent bunk-group writes for one room so two "add a bed to
// Bunk A" requests can't both pass the membership check and create an invalid
// three-bed (or two-top) group. The rule can't be a unique index and partial
// indexes are out of scope (#1675), so a row lock on the owning room is the
// serialisation point. Callers run this inside a transaction (self-wrapped when
// no client is supplied).
async function lockRoomForBunkGroup(roomId: string, db: BedAllocationDb) {
  await db.$queryRaw`SELECT id FROM "LodgeRoom" WHERE id = ${roomId} FOR UPDATE`;
}

async function assertBunkGroupCanAdmit(input: {
  roomId: string;
  bunkGroup: string;
  bedType: BedType;
  // The bed being updated is excluded so re-saving it never conflicts with
  // itself.
  excludeBedId?: string;
  db: BedAllocationDb;
}) {
  const others = await input.db.lodgeBed.findMany({
    where: {
      roomId: input.roomId,
      bunkGroup: input.bunkGroup,
      ...(input.excludeBedId ? { id: { not: input.excludeBedId } } : {}),
    },
    // name/active drive the deactivated-blocker steer: an inactive bed still
    // counts toward the group (membership semantics unchanged), so when it is
    // the reason a save is rejected the message names it and tells the admin to
    // reactivate or delete it — otherwise the slot looks mysteriously taken.
    select: { id: true, bedType: true, name: true, active: true },
  });

  if (others.length >= 2) {
    const deactivated = others.filter((bed) => bed.active === false);
    if (deactivated.length > 0) {
      // Reactivating or deleting a deactivated member only makes room for the
      // incoming bed when that member shares its type — it holds the very slot
      // the new bed wants. A deactivated opposite-type member can't be acted on
      // to admit a same-type bed, so name it but steer only to another group.
      const sameType = deactivated.filter(
        (bed) => bed.bedType === input.bedType,
      );
      if (sameType.length > 0) {
        const plural = sameType.length > 1;
        throw new BedAllocationAdminError(
          `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
            plural ? "s" : ""
          } ${quotedBedNames(sameType.map((bed) => bed.name))}. Reactivate or delete ${
            plural ? "them" : "it"
          }, or use another group.`,
          409,
        );
      }
      const plural = deactivated.length > 1;
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
          plural ? "s" : ""
        } ${quotedBedNames(deactivated.map((bed) => bed.name))}. Use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has two beds. A bunk pairs one top and one bottom.`,
      409,
    );
  }

  const partner = others[0];
  if (partner && partner.bedType === input.bedType) {
    if (partner.active === false) {
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
          input.bedType,
        )} bed — the deactivated bed "${partner.name}". Reactivate or delete it, or use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
        input.bedType,
      )} bed. Pair a top with a bottom.`,
      409,
    );
  }
}

// The bed CREATE path never looks the room up (the route validates roomId only
// as a non-empty string), so any bogus or stale roomId — most commonly a room
// deleted in another tab — trips the
// LodgeBed.roomId -> LodgeRoom Restrict FK as P2003. That FK is the only one a
// bed insert can violate (roomId is LodgeBed's only outgoing relation; its
// BedAllocation children don't exist yet at create time, and the bunk lock +
// membership steps are read-only), so any P2003 raised inside
// createBedAllocationBed is unambiguously the missing room — no
// constraint-metadata classifier is needed here, unlike deleteBedAllocationRoom
// which must disambiguate two FKs. Steer the admin to refresh instead of the
// shared delete-history message, which is nonsense on the create path (#1700).
const ROOM_FOR_BED_MISSING_MESSAGE =
  "The room for this bed no longer exists. Refresh and try again.";

// 404 (not 409): the referenced room is genuinely gone, mirroring this file's
// other resource-not-found mappings ("Room not found" / "Bed not found") and the
// shared mapper's P2025 -> 404. This is distinct from the 409
// ROOM_CHANGED_WHILE_DELETING race, where the room still exists but a new child
// blocks the delete (a true conflict).
function mapMissingRoomOnBedCreate(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  ) {
    return new BedAllocationAdminError(ROOM_FOR_BED_MISSING_MESSAGE, 404);
  }
  return error;
}

export async function createBedAllocationBed(input: {
  roomId: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
  bedType?: BedType;
  bunkGroup?: string | null;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023), matching the other
  // self-recursive transaction helpers here.
}): Promise<LodgeBed> {
  const bedType = input.bedType ?? "SINGLE";
  const bunkGroup = normalizeBunkGroup(input.bunkGroup);
  assertBunkGroupTypeConsistency(bedType, bunkGroup);

  try {
    // Only a grouped bed needs the serialised room lock + membership check; an
    // ungrouped bed skips the transaction entirely. `await` before returning so
    // a create-time P2003 is caught here (the recursive $transaction branch
    // rejects with the already-mapped error, which passes through unchanged).
    if (bunkGroup) {
      if (!input.db) {
        return await prisma.$transaction((tx) =>
          createBedAllocationBed({ ...input, db: tx }),
        );
      }
      const db = input.db;
      await lockRoomForBunkGroup(input.roomId, db);
      await assertBunkGroupCanAdmit({
        roomId: input.roomId,
        bunkGroup,
        bedType,
        db,
      });
      return await db.lodgeBed.create({
        data: {
          roomId: input.roomId,
          name: input.name.trim(),
          sortOrder: input.sortOrder ?? 0,
          active: input.active ?? true,
          bedType,
          bunkGroup,
        },
      });
    }

    return await (input.db ?? prisma).lodgeBed.create({
      data: {
        roomId: input.roomId,
        name: input.name.trim(),
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true,
        bedType,
        bunkGroup: null,
      },
    });
  } catch (error) {
    throw mapMissingRoomOnBedCreate(error);
  }
}

export async function updateBedAllocationBed(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  bedType?: BedType;
  bunkGroup?: string | null;
  db?: BedAllocationDb;
}): Promise<LodgeBed> {
  // A bunk-affecting edit (type or group) re-validates pairing under a room
  // lock, so it must run in a transaction; self-wrap when no client is given.
  const touchesBunk =
    input.bedType !== undefined || input.bunkGroup !== undefined;
  if (touchesBunk && !input.db) {
    return prisma.$transaction((tx) =>
      updateBedAllocationBed({ ...input, db: tx }),
    );
  }

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

  if (touchesBunk) {
    const existing = await db.lodgeBed.findUnique({
      where: { id: input.id },
      select: { roomId: true, bedType: true, bunkGroup: true },
    });
    if (!existing) {
      throw new BedAllocationAdminError("Bed not found", 404);
    }

    // Re-validate against the bed's current room so a rename/regroup keeps the
    // pairing consistent, using the requested change layered over the stored
    // values.
    const nextBedType = input.bedType ?? existing.bedType;
    const nextBunkGroup =
      input.bunkGroup !== undefined
        ? normalizeBunkGroup(input.bunkGroup)
        : existing.bunkGroup;

    assertBunkGroupTypeConsistency(nextBedType, nextBunkGroup);

    if (nextBunkGroup) {
      await lockRoomForBunkGroup(existing.roomId, db);
      await assertBunkGroupCanAdmit({
        roomId: existing.roomId,
        bunkGroup: nextBunkGroup,
        bedType: nextBedType,
        excludeBedId: input.id,
        db,
      });
    }

    if (input.bedType !== undefined) data.bedType = input.bedType;
    if (input.bunkGroup !== undefined) data.bunkGroup = nextBunkGroup;
  }

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

// Shared by the pre-check guard and the FK backstop so the concurrent-write
// race resolves to the exact same steering message an up-front check would give.
const ROOM_HAS_ALLOCATION_HISTORY_MESSAGE =
  "This room has allocation history and cannot be deleted. Deactivate it instead.";

// A bed added by another admin between the guard and the room delete trips the
// LodgeBed -> room Restrict FK, which is not allocation history — steer to a
// retry rather than to Deactivate.
const ROOM_CHANGED_WHILE_DELETING_MESSAGE =
  "Room changed while deleting (a bed was just added). Refresh and try again.";

// Classify a P2003 caught during the bed+room deletes. The pg driver adapter
// can drop the structured constraint field (see booking-envelope-invariants),
// so scan the message and any surviving meta. A BedAllocation FK means real
// allocation history (the raw pg message names LodgeBed as the table being
// modified in that case too, so BedAllocation must win when both appear); a
// LodgeBed -> room FK means a bed was added mid-delete; anything else falls
// back to the allocation-history steer.
function p2003TargetsLodgeBedRoomFk(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const meta = error.meta as
    | { field_name?: unknown; constraint?: unknown }
    | undefined;
  const text = [
    error.message,
    typeof meta?.field_name === "string" ? meta.field_name : "",
    typeof meta?.constraint === "string" ? meta.constraint : "",
  ]
    .join(" ")
    .toLowerCase();
  if (text.includes("bedallocation")) return false;
  return text.includes("lodgebed");
}

async function assertNoRoomAllocationHistory(
  roomId: string,
  db: BedAllocationDb,
) {
  // Any allocation row for the room (past or future) blocks a hard delete —
  // unlike the bed deactivate guard, which only cares about future dates. Rooms
  // with history keep their audit trail and are deactivated instead.
  const existing = await db.bedAllocation.findFirst({
    where: { roomId },
    select: { id: true },
  });
  if (existing) {
    throw new BedAllocationAdminError(ROOM_HAS_ALLOCATION_HISTORY_MESSAGE, 409);
  }
}

export async function deleteBedAllocationRoom(input: {
  id: string;
  // Optional lodge scope, consistent with the other room functions: when
  // supplied the room must belong to this lodge (else 404). The route mirrors
  // the bed DELETE and does not pass it; callers that carry lodge context can
  // scope the delete defensively.
  lodgeId?: string;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023), matching the annotation on
  // the other self-recursive transaction helpers here.
}): Promise<LodgeRoom> {
  // Run the history guard and the bed+room deletes in one transaction so a
  // concurrent allocation cannot slip between the check and the delete. A
  // caller-supplied client is assumed to already be transactional.
  if (!input.db) {
    return prisma.$transaction((tx) =>
      deleteBedAllocationRoom({ ...input, db: tx }),
    );
  }
  const db = input.db;

  const room = await db.lodgeRoom.findFirst({
    where: {
      id: input.id,
      ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
    },
    select: { id: true },
  });
  if (!room) {
    throw new BedAllocationAdminError("Room not found", 404);
  }

  await assertNoRoomAllocationHistory(room.id, db);

  try {
    // The room's beds go with it under the same guard. Deleting the beds first
    // also trips the BedAllocation composite (bedId, roomId) FK if an
    // allocation was created after the guard ran.
    await db.lodgeBed.deleteMany({ where: { roomId: room.id } });
    return await db.lodgeRoom.delete({ where: { id: room.id } });
  } catch (error) {
    // FK Restrict backstop closing the guard->delete race. A concurrently
    // created BedAllocation (BedAllocation.room / .bed are onDelete: Restrict)
    // surfaces as P2003 and rolls the transaction back — map it to the same
    // steering message as the up-front guard. A bed added mid-delete trips the
    // LodgeBed -> room FK instead, which is not history, so steer to a retry.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      throw new BedAllocationAdminError(
        p2003TargetsLodgeBedRoomFk(error)
          ? ROOM_CHANGED_WHILE_DELETING_MESSAGE
          : ROOM_HAS_ALLOCATION_HISTORY_MESSAGE,
        409,
      );
    }
    throw error;
  }
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
      bedType: bed.bedType,
      bunkGroup: bed.bunkGroup,
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
