import { BookingStatus, Prisma, type BedAllocation } from "@prisma/client";

import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationBooking,
  type BedAllocationDisplacement,
  type BedAllocationRoom,
} from "@/lib/bed-allocation";
import { createAuditLog } from "@/lib/audit";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
} from "@/lib/date-only";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

type BedAllocationLifecycleDb = Prisma.TransactionClient | typeof prisma;

// Statuses whose bookings may own a per-night BedAllocation row.
//
// This is a deliberate superset of CAPACITY_HOLDING_BOOKING_STATUSES (in
// booking-status.ts). Every capacity-holding status appears here, plus the
// provisional/offered "pre-assignment" statuses (PENDING, PAYMENT_PENDING,
// WAITLIST_OFFERED) that may be assigned a bed before they commit lodge
// capacity. The two sets are kept distinct on purpose; the ownership boundary
// is locked down by booking-status-bed-allocation-ownership.test.ts (issue
// #813), so any change here must keep capacity-holding ⊆ bed-allocatable.
export const BED_ALLOCATABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.WAITLIST_OFFERED,
] as const;

interface BedAllocationLifecycleRange {
  checkIn: Date;
  checkOut: Date;
}

export interface BedAllocationLifecycleResult {
  enabled: boolean;
  deletedCount: number;
  createdCount: number;
  // Second occupants promoted to primary because the prune removed a shared
  // double's primary from another booking (#1750). Assertable via the reconcile
  // return, not only via the update spy.
  promotedCount: number;
}

export interface OrphanedBedNight {
  bedId: string;
  stayDate: Date;
}

/**
 * Promote the surviving second occupant to primary on each bed-night that just
 * lost its primary — a board delete (#1743), a board move of the primary to
 * another bed, or a cross-booking lifecycle prune (#1750). Without this, a lone
 * `isSecondOccupant=true` row is a safe dead-end (visible, no constraint
 * violation) but the orphan guard in `resolveSecondOccupant` blocks every new
 * placement on that bed-night until it is manually removed.
 *
 * The gate is `isSecondOccupant` only, NEVER the denormalized `bedType` of the
 * removed primary OR the survivor: AUTO-created rows carry the default SINGLE
 * even on a real DOUBLE (#1749), so trusting that type would skip the promotion
 * the partner needs — the exact failure #1749's "never trust denormalized
 * bedType" fix targeted, here in the REPAIR mechanism where declining silently
 * dead-ends the bed-night behind the orphan guard forever. A second-occupant row
 * can only exist on a genuine shared DOUBLE (`resolveSecondOccupant` checks the
 * live bed + the partial index enforces it), so the `isSecondOccupant=true`
 * lookup finds nothing on any other bed and nothing is written. The JS re-check
 * of `partner.isSecondOccupant` (the WHERE clause is the real gate) keeps a test
 * mock — whose `findFirst` ignores the WHERE — from fabricating a promotion.
 *
 * Runs on the supplied client so the caller's transaction wraps delete/move +
 * flip atomically. The removed primary must already be gone, so the flip to
 * `isSecondOccupant=false` cannot collide with
 * `@@unique([bedId, stayDate, isSecondOccupant])`. Returns the promoted rows so
 * the caller can audit them — a promoted partner may belong to a DIFFERENT
 * booking than the row that was removed.
 */
export async function promoteOrphanedSecondOccupants(
  db: BedAllocationLifecycleDb,
  bedNights: OrphanedBedNight[],
): Promise<BedAllocation[]> {
  const promoted: BedAllocation[] = [];
  const seen = new Set<string>();
  for (const { bedId, stayDate } of bedNights) {
    // Dedup: the same (bedId, stayDate) must never be flipped twice.
    const key = `${bedId}:${formatDateOnly(stayDate)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const partner = await db.bedAllocation.findFirst({
      where: { bedId, stayDate, isSecondOccupant: true },
    });
    if (partner && partner.isSecondOccupant) {
      const updated = await db.bedAllocation.update({
        where: { id: partner.id },
        data: { isSecondOccupant: false },
      });
      promoted.push(updated);
    }
  }
  return promoted;
}

async function recordPartnerPromotionAudit(
  db: BedAllocationLifecycleDb,
  promoted: BedAllocation,
): Promise<void> {
  // Best-effort, mirroring recordBedDisplacementAudit: an audit-write failure
  // must never roll back a committed promotion. There is no acting member on the
  // lifecycle path (the promotion is a system-driven consequence of a prune), so
  // this is a "lodge" system event rather than an "admin" action, and it is
  // recorded against the PROMOTED partner's own booking — which may differ from
  // the booking whose prune triggered it.
  try {
    await createAuditLog(
      {
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        category: "lodge",
        entityType: "BedAllocation",
        entityId: promoted.id,
        targetId: promoted.bookingId,
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was pruned by a lifecycle change on another booking",
        metadata: {
          issue: 1750,
          allocationId: promoted.id,
          bedId: promoted.bedId,
          stayDate: formatDateOnly(promoted.stayDate),
        },
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err, promoted },
      "Failed to record partner promotion audit",
    );
  }
}

/**
 * Delete allocations matching `where`, promoting any second occupant left
 * orphaned when the sweep removes a shared double's primary (#1750). The
 * affected bed-nights are captured BEFORE the delete (a `deleteMany` returns
 * only a count) and the survivors are flipped AFTER, on the SAME client the
 * sweep runs on — reconcile often already runs inside a caller's transaction, so
 * this deliberately never opens a nested one. Delete-first/flip-after keeps the
 * flip from colliding with `@@unique([bedId, stayDate, isSecondOccupant])`.
 */
async function sweepAllocationsWithPromotion(
  db: BedAllocationLifecycleDb,
  where: Prisma.BedAllocationWhereInput,
): Promise<{ deletedCount: number; promotedCount: number }> {
  // Bed-nights whose PRIMARY this sweep will delete. Only a deleted primary can
  // orphan a partner, so the capture is scoped to isSecondOccupant=false — but
  // NOT to bedType (#1749: an AUTO primary on a real DOUBLE carries the stale
  // SINGLE default; filtering it out would strand its partner).
  const doomedPrimaries = await db.bedAllocation.findMany({
    where: { ...where, isSecondOccupant: false },
    select: { bedId: true, stayDate: true },
  });

  const deleted = await db.bedAllocation.deleteMany({ where });

  if (doomedPrimaries.length === 0) {
    return { deletedCount: deleted.count, promotedCount: 0 };
  }

  const promoted = await promoteOrphanedSecondOccupants(db, doomedPrimaries);
  for (const row of promoted) {
    await recordPartnerPromotionAudit(db, row);
  }
  return { deletedCount: deleted.count, promotedCount: promoted.length };
}

interface ReconcileBedAllocationsForBookingInput {
  bookingId: string;
  db?: BedAllocationLifecycleDb;
  // Retained for API stability and as pruning context for the ~45 call sites
  // that pass a booking's pre-change dates. Since #1686 the auto-placement
  // range is the booking's CURRENT range only; stale rows outside it are
  // already handled by pruneAllocationsForBooking, so previousRange no longer
  // widens the planner scan.
  previousRange?: BedAllocationLifecycleRange | null;
}

interface AutoAllocateMissingBedNightsInput {
  db: BedAllocationLifecycleDb;
  // The reconciled booking whose guests are the ONLY ones auto-placed (#1686).
  // The room/occupancy loads below stay lodge-wide across the range so the
  // planner still sees every occupied bed-night (and can displace provisional
  // occupants for a held booking, #1387/#1677), but no OTHER booking's missing
  // guest-nights are opportunistically drafted into the freed/idle beds.
  bookingId: string;
  range: BedAllocationLifecycleRange;
  // Lodge of the booking being reconciled. Auto-fill must never place a
  // guest into another lodge's bed (lodge-scoping contract); null (booking
  // missing/pre-backfill) keeps the club-wide behaviour, which is exact
  // while one lodge exists.
  lodgeId?: string | null;
}

type BookingForBedAllocation = Awaited<
  ReturnType<typeof loadBookingForBedAllocation>
>;

function isAllocatableBookingStatus(status: string): boolean {
  return (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

function normalizeRange(
  range?: BedAllocationLifecycleRange | null,
): BedAllocationLifecycleRange | null {
  if (!range || range.checkOut <= range.checkIn) return null;
  return range;
}

function clampRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationLifecycleRange,
): BedAllocationLifecycleRange | null {
  return normalizeRange({
    checkIn: stayStart > range.checkIn ? stayStart : range.checkIn,
    checkOut: stayEnd < range.checkOut ? stayEnd : range.checkOut,
  });
}

async function loadBookingForBedAllocation(
  db: BedAllocationLifecycleDb,
  bookingId: string,
) {
  return db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      guests: {
        select: {
          id: true,
          bookingId: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
          // Explicit night set (issue #713): allocations are pruned/created per
          // included night, so non-contiguous stays only hold beds on the
          // nights the guest actually stays.
          nights: { select: { stayDate: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
}

/**
 * The dates a guest actually stays within a date range (issue #713). Uses the
 * explicit night set when present; otherwise the contiguous stayStart/stayEnd
 * range clamped to the range — the pre-#713 behaviour.
 */
function getGuestNightDatesInRange(
  guest: { stayStart: Date; stayEnd: Date; nights?: { stayDate: Date }[] },
  range: BedAllocationLifecycleRange
): Date[] {
  const rangeStartKey = formatDateOnly(range.checkIn);
  const rangeEndKey = formatDateOnly(range.checkOut); // exclusive
  if (guest.nights && guest.nights.length > 0) {
    return guest.nights
      .map((night) => night.stayDate)
      .filter((stayDate) => {
        const key = formatDateOnly(stayDate);
        return key >= rangeStartKey && key < rangeEndKey;
      })
      .sort((a, b) => a.getTime() - b.getTime());
  }
  const clamped = clampRange(guest.stayStart, guest.stayEnd, range);
  if (!clamped) return [];
  return eachDateOnlyInRange(clamped.checkIn, clamped.checkOut);
}

async function pruneAllocationsForBooking(
  db: BedAllocationLifecycleDb,
  bookingId: string,
  booking: BookingForBedAllocation,
): Promise<{ deletedCount: number; promotedCount: number }> {
  if (
    !booking ||
    booking.deletedAt ||
    !isAllocatableBookingStatus(booking.status) ||
    booking.guests.length === 0
  ) {
    // Whole-booking sweep (cancelled / soft-deleted / non-allocatable / no
    // guests): cancelling the primary's booking orphans a partner sitting on
    // ANOTHER booking (sharing eligibility is member-level), so promote after
    // the sweep (#1750).
    return sweepAllocationsWithPromotion(db, { bookingId });
  }

  const guestIds = booking.guests.map((guest) => guest.id);
  const staleGuestNightClauses: Prisma.BedAllocationWhereInput[] = [
    { bookingGuestId: { notIn: guestIds } },
  ];

  for (const guest of booking.guests) {
    const nightDates = guest.nights?.map((night) => night.stayDate) ?? [];
    if (nightDates.length > 0) {
      // Prune any allocation on a night the guest no longer stays — this covers
      // gaps in a non-contiguous stay and nights switched off in the grid
      // (issue #713), not just the range edges.
      staleGuestNightClauses.push({
        bookingGuestId: guest.id,
        stayDate: { notIn: nightDates },
      });
    } else {
      staleGuestNightClauses.push(
        {
          bookingGuestId: guest.id,
          stayDate: { lt: guest.stayStart },
        },
        {
          bookingGuestId: guest.id,
          stayDate: { gte: guest.stayEnd },
        },
      );
    }
  }

  // Stale guest-night sweep (date change / night dropped / guest removed):
  // dropping a night on which the guest was a shared double's primary orphans a
  // partner from another booking, so promote after the sweep (#1750).
  return sweepAllocationsWithPromotion(db, {
    bookingId,
    OR: staleGuestNightClauses,
  });
}

/**
 * Per-lodge auto-allocation switch (lodge-scoping contract): a lodge's own
 * settings row (id = lodgeId) wins; otherwise the legacy "default" row
 * applies when it is unlinked or soft-linked to this lodge; missing rows
 * default to enabled. Exported for the admin settings surface.
 */
export async function resolveAutoAllocationEnabled(
  db: {
    bedAllocationSettings: {
      findUnique: (args: {
        where: { id: string };
      }) => Promise<{ autoAllocationEnabled: boolean; lodgeId?: string | null } | null>;
    };
  },
  lodgeId?: string | null,
): Promise<boolean> {
  if (lodgeId && lodgeId !== "default") {
    const ownRow = await db.bedAllocationSettings.findUnique({
      where: { id: lodgeId },
    });
    if (ownRow) return ownRow.autoAllocationEnabled;
  }
  const legacy = await db.bedAllocationSettings.findUnique({
    where: { id: "default" },
  });
  if (!legacy) return true;
  if (lodgeId && legacy.lodgeId && legacy.lodgeId !== lodgeId) {
    return true;
  }
  return legacy.autoAllocationEnabled;
}

async function autoAllocateMissingBedNights({
  db,
  bookingId,
  range,
  lodgeId,
}: AutoAllocateMissingBedNightsInput): Promise<number> {
  const enabled = await resolveAutoAllocationEnabled(db, lodgeId);
  if (!enabled) {
    return 0;
  }

  const [rooms, bookings] = await Promise.all([
    db.lodgeRoom.findMany({
      where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
      include: { beds: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    }),
    db.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
        checkIn: { lt: range.checkOut },
        checkOut: { gt: range.checkIn },
        guests: {
          some: {
            stayStart: { lt: range.checkOut },
            stayEnd: { gt: range.checkIn },
          },
        },
        ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
      },
      select: {
        id: true,
        createdAt: true,
        requestedRoomId: true,
        // #1677 envelope widening: the overlapping bookings' own stay windows
        // widen the loads below so the planner sees WHOLE stays.
        checkIn: true,
        checkOut: true,
        // #1387: classify each booking Held vs Provisional so the planner can
        // give capacity-holding bookings first claim on beds.
        status: true,
        originBookingRequest: { select: { id: true } },
        // Whole-stay planning (issue #1677): load every guest of an
        // overlapping booking, not just the reconcile-range slice — guest
        // stays sit inside the booking envelope, which is inside the widened
        // load envelope by construction.
        guests: {
          select: {
            id: true,
            bookingId: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  // Envelope widening (issue #1677): clip loads to [min(checkIn), max(checkOut)]
  // of the bookings overlapping the reconcile range, union the range itself.
  // The planner then plans whole stays instead of range slices, while the
  // planner bookings SET stays restricted to bookings overlapping the original
  // range (no cascade to neighbours-of-neighbours).
  let envelopeCheckIn = range.checkIn;
  let envelopeCheckOut = range.checkOut;
  for (const booking of bookings) {
    if (booking.checkIn && booking.checkIn < envelopeCheckIn) {
      envelopeCheckIn = booking.checkIn;
    }
    if (booking.checkOut && booking.checkOut > envelopeCheckOut) {
      envelopeCheckOut = booking.checkOut;
    }
  }
  const envelope: BedAllocationLifecycleRange = {
    checkIn: envelopeCheckIn,
    checkOut: envelopeCheckOut,
  };

  const existingAllocations = await db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: envelope.checkIn,
        lt: envelope.checkOut,
      },
      ...(lodgeId ? { room: lodgeNullTolerantScope(lodgeId) } : {}),
    },
    select: {
      bedId: true,
      bookingId: true,
      bookingGuestId: true,
      roomId: true,
      stayDate: true,
      // #1387: an admin-approved allocation (#776 lock) is never displaced —
      // and (#1677) one approved night pins its whole booking.
      approvedAt: true,
      // #1387: classify each occupied bed-night Held vs Provisional so the
      // planner never displaces a capacity-holding occupant. createdAt orders
      // newest-first eviction and checkIn/checkOut flag stays that extend past
      // the envelope as non-displaceable (#1677).
      booking: {
        select: {
          status: true,
          createdAt: true,
          checkIn: true,
          checkOut: true,
          originBookingRequest: { select: { id: true } },
        },
      },
      bookingGuest: {
        select: {
          ageTier: true,
        },
      },
    },
  });

  const allocatedGuestNights = new Set(
    existingAllocations.map(
      (allocation) =>
        `${allocation.bookingGuestId}:${formatDateOnly(allocation.stayDate)}`,
    ),
  );

  const plannerBookings: BedAllocationBooking[] = bookings
    // #1686: only the reconciled booking's guests are auto-placed. Other
    // overlapping bookings were loaded above so the planner can widen the load
    // envelope (#1677) and see/displace their occupancy (#1387), but their own
    // missing guest-nights are never opportunistically drafted here — lodge-
    // wide re-planning belongs exclusively to the explicit board action.
    .filter((booking) => booking.id === bookingId)
    .map((booking): BedAllocationBooking | null => {
      const guests: BedAllocationBooking["guests"] = [];

      for (const guest of booking.guests) {
        // Allocate only the nights the guest actually stays (issue #713):
        // a non-contiguous stay gets beds on its included nights, not the
        // whole envelope. The widened load envelope (#1677) exposes the
        // guest's WHOLE stay so the planner can keep it in one room.
        for (const stayDate of getGuestNightDatesInRange(guest, envelope)) {
          const stayDateKey = formatDateOnly(stayDate);
          if (allocatedGuestNights.has(`${guest.id}:${stayDateKey}`)) {
            continue;
          }

          guests.push({
            id: guest.id,
            bookingId: booking.id,
            ageTier: guest.ageTier,
            stayStart: stayDate,
            stayEnd: addDaysDateOnly(stayDate, 1),
          });
        }
      }

      return guests.length
        ? {
            id: booking.id,
            createdAt: booking.createdAt,
            requestedRoomId: booking.requestedRoomId,
            holdsCapacity: bookingHoldsCapacity({
              status: booking.status,
              isRequestConverted: Boolean(booking.originBookingRequest),
            }),
            guests,
          }
        : null;
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));

  if (plannerBookings.length === 0) {
    return 0;
  }

  const plannerRooms = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];

  const plan = buildFirstFitBedAllocationPlan({
    enabled: true,
    // #1387: capacity-holding bookings get first claim; a blocking provisional
    // allocation is moved aside or unallocated so a held booking always gets a
    // bed the availability math already admitted it to.
    prioritizeCapacityHolding: true,
    rooms: plannerRooms,
    bookings: plannerBookings,
    occupiedBedNights: existingAllocations.map((allocation) => ({
      bedId: allocation.bedId,
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      stayDate: allocation.stayDate,
      ageTier: allocation.bookingGuest.ageTier,
      approvedAt: allocation.approvedAt,
      // #1677: newest provisional bookings are evicted first when a held
      // booking needs a whole room.
      bookingCreatedAt: allocation.booking?.createdAt ?? null,
      // #1677: a stay extending past the loaded envelope is only partially
      // visible, so a whole-stay move is impossible — treat it as
      // non-displaceable (mirrors the holdsCapacity-undefined default).
      stayExtendsBeyondWindow: Boolean(
        allocation.booking &&
          ((allocation.booking.checkIn &&
            allocation.booking.checkIn < envelope.checkIn) ||
            (allocation.booking.checkOut &&
              allocation.booking.checkOut > envelope.checkOut)),
      ),
      holdsCapacity: allocation.booking
        ? bookingHoldsCapacity({
            status: allocation.booking.status,
            isRequestConverted: Boolean(
              allocation.booking.originBookingRequest,
            ),
          })
        : false,
    })),
  });

  if (plan.allocations.length === 0) {
    return 0;
  }

  const createManyArgs = {
    data: plan.allocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: new Date(`${allocation.stayDate}T00:00:00.000Z`),
      source: allocation.source,
    })),
    skipDuplicates: true,
  };

  const displacements = plan.displacements ?? [];

  // Common case (no displacement): a plain createMany, unchanged.
  if (displacements.length === 0) {
    const created = await db.bedAllocation.createMany(createManyArgs);
    return created.count;
  }

  // Apply the provisional MOVEs/UNALLOCATEs BEFORE creating the new capacity-
  // holding allocations, so the freed beds are available and no transient
  // @@unique([bedId, stayDate]) conflict occurs (issue #1387). updateMany/
  // deleteMany (not update/delete) make a row that was concurrently pruned an
  // idempotent no-op (count 0) rather than a P2025 crash.
  const applyPlan = async (client: BedAllocationLifecycleDb) => {
    for (const displacement of displacements) {
      const where = {
        bookingGuestId: displacement.bookingGuestId,
        stayDate: new Date(`${displacement.stayDate}T00:00:00.000Z`),
      };
      if (
        displacement.type === "MOVE" &&
        displacement.toBedId &&
        displacement.toRoomId
      ) {
        await client.bedAllocation.updateMany({
          where,
          data: { bedId: displacement.toBedId, roomId: displacement.toRoomId },
        });
      } else {
        await client.bedAllocation.deleteMany({ where });
      }
    }
    return client.bedAllocation.createMany(createManyArgs);
  };

  // Apply atomically: a failed createMany after an UNALLOCATE must never
  // permanently drop the provisional row. If the caller already runs us inside
  // a transaction (db is a TransactionClient with no `$transaction`), apply
  // inline on that client; otherwise open our own transaction.
  const transactionalDb = db as typeof prisma;
  const canOpenTransaction = typeof transactionalDb.$transaction === "function";

  let created: { count: number };
  if (canOpenTransaction) {
    created = await transactionalDb.$transaction((tx) => applyPlan(tx));
  } else {
    created = await applyPlan(db);
  }

  // Audit trail: record each displacement on the displaced PROVISIONAL booking
  // AFTER the plan is applied (post-commit when we own the transaction) so an
  // audit-write failure can never roll back a committed displacement, and every
  // committed displacement always attempts its audit. Best-effort (swallowed).
  for (const displacement of displacements) {
    await recordBedDisplacementAudit(db, displacement);
  }

  return created.count;
}

async function recordBedDisplacementAudit(
  db: BedAllocationLifecycleDb,
  displacement: BedAllocationDisplacement,
): Promise<void> {
  const summary =
    displacement.type === "MOVE"
      ? `Auto-allocation moved this provisional booking's bed on ${displacement.stayDate} to another bed so a capacity-holding booking could claim it (issue #1387).`
      : `Auto-allocation returned this provisional booking's bed on ${displacement.stayDate} to the awaiting-allocation queue so a capacity-holding booking could claim it (issue #1387).`;

  try {
    await createAuditLog(
      {
        action: "bed_allocation.provisional_displaced",
        category: "lodge",
        entityType: "Booking",
        entityId: displacement.bookingId,
        targetId: displacement.bookingId,
        outcome: "success",
        summary,
        metadata: {
          issue: 1387,
          displacementType: displacement.type,
          stayDate: displacement.stayDate,
          displacedBookingId: displacement.bookingId,
          displacedBookingGuestId: displacement.bookingGuestId,
          fromBedId: displacement.fromBedId,
          toBedId: displacement.toBedId ?? null,
          displacedByBookingId: displacement.displacedByBookingId,
        },
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err, displacement },
      "Failed to record bed displacement audit",
    );
  }
}

export async function reconcileBedAllocationsForBooking({
  bookingId,
  db = prisma,
}: ReconcileBedAllocationsForBookingInput): Promise<BedAllocationLifecycleResult> {
  const enabled = await isEffectiveModuleEnabled("bedAllocation", db);

  if (!enabled) {
    return { enabled: false, deletedCount: 0, createdCount: 0, promotedCount: 0 };
  }

  const booking = await loadBookingForBedAllocation(db, bookingId);
  const { deletedCount, promotedCount } = await pruneAllocationsForBooking(
    db,
    bookingId,
    booking,
  );

  // #1686: auto-placement is scoped to THIS booking on its CURRENT nights.
  // previousRange no longer widens the planner scan (pruning already removed
  // stale rows), so a date change/cancellation never re-plans anyone else into
  // the freed beds. When the booking cannot receive allocations at all —
  // missing, soft-deleted, non-allocatable status (cancelled etc.), or an
  // empty range — skip the planner entirely: it would deterministically place
  // nothing, and cancel/delete flows call this inside their transactions.
  const bookingCanReceiveAllocations = Boolean(
    booking && !booking.deletedAt && isAllocatableBookingStatus(booking.status),
  );
  const currentRange = normalizeRange(
    bookingCanReceiveAllocations && booking
      ? { checkIn: booking.checkIn, checkOut: booking.checkOut }
      : null,
  );
  const createdCount = currentRange
    ? await autoAllocateMissingBedNights({
        db,
        bookingId,
        range: currentRange,
        lodgeId: booking?.lodgeId ?? null,
      })
    : 0;

  return { enabled: true, deletedCount, createdCount, promotedCount };
}
