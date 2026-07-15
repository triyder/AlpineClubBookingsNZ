import { BookingStatus, type Prisma, type PrismaClient } from "@prisma/client";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import {
  isGuestActiveOnNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

const BOOKING_MEMBER_NIGHT_CONFLICT_CODE =
  "BOOKING_MEMBER_NIGHT_CONFLICT";

const BOOKING_MEMBER_NIGHT_LOCK_NAMESPACE = "booking-member-night";

// The subset of a transaction client this module needs to take the per-member
// advisory lock. `prisma` and any `Prisma.TransactionClient` both satisfy it.
type MemberNightLockClient = { $executeRaw: Prisma.TransactionClient["$executeRaw"] };

function hasExecuteRaw(db: unknown): db is MemberNightLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $executeRaw?: unknown }).$executeRaw === "function"
  );
}

/**
 * Serialise the member-night guard ACROSS LODGES (#1881). The person-night
 * invariant — "a linked member is on at most one live booking per lodge night"
 * — spans lodges (`findBookingMemberNightConflicts` intentionally ignores
 * `lodgeId`), but capacity claims serialise only PER lodge
 * (`acquireLodgeCapacityLock`). So two concurrent writers creating/re-dating the
 * SAME member's footprint at DIFFERENT lodges hold different capacity locks and
 * both pass the guard, double-booking the member. Take a per-member
 * transaction-scoped advisory lock for every member-linked guest BEFORE the
 * guard reads, in sorted memberId order so composing several can never deadlock
 * (the same sorted-order discipline the multi-lodge processor uses). Keyed in
 * its own namespace, so it never contends with the per-lodge, global, or
 * credit-ledger locks. Callers take this AFTER their per-lodge lock, giving a
 * consistent lodge → member-night acquisition order.
 */
export async function lockBookingMemberNights(
  db: MemberNightLockClient,
  guests: readonly ConflictGuestInput[],
): Promise<void> {
  const memberIds = Array.from(
    new Set(
      guests
        .map((guest) => guest.memberId)
        .filter((id): id is string => Boolean(id)),
    ),
  ).sort();
  for (const memberId of memberIds) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BOOKING_MEMBER_NIGHT_LOCK_NAMESPACE}), hashtext(${memberId}))`;
  }
}

// test seam
export const MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES = [
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
] as const;

const SELF_REMOVABLE_MEMBER_NIGHT_CONFLICT_STATUSES = new Set<string>([
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
]);

type ConflictDb =
  | Pick<PrismaClient, "bookingGuest">
  | Pick<Prisma.TransactionClient, "bookingGuest">;

type ConflictGuestInput = GuestStayRange & {
  memberId?: string | null;
};

export type BookingMemberNightConflict = {
  memberId: string;
  memberName: string;
  bookingId: string;
  bookingStatus: BookingStatus;
  bookingOwnerName: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  guestId: string;
  conflictingNights: string[];
  isOwnBooking: boolean;
  canOpenBooking: boolean;
  canSelfRemove: boolean;
};

export class BookingMemberNightConflictError extends Error {
  constructor(public readonly conflicts: BookingMemberNightConflict[]) {
    super(
      conflicts.length === 1
        ? `${conflicts[0].memberName} is already on a booking for one of these nights.`
        : "One or more members are already on a booking for these nights.",
    );
    this.name = "BookingMemberNightConflictError";
  }
}

function displayName(firstName?: string | null, lastName?: string | null) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || "Member";
}

function requestedNightsByMember(
  guests: readonly ConflictGuestInput[],
  checkIn: Date,
  checkOut: Date,
) {
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const end = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, end);
  const byMember = new Map<string, Set<string>>();

  for (const guest of guests) {
    if (!guest.memberId) continue;
    const bookingRange = { checkIn: start, checkOut: end };
    for (const night of nights) {
      if (!isGuestActiveOnNight(guest, night, bookingRange)) continue;
      const memberNights = byMember.get(guest.memberId) ?? new Set<string>();
      memberNights.add(formatDateOnly(night));
      byMember.set(guest.memberId, memberNights);
    }
  }

  return byMember;
}

export async function findBookingMemberNightConflicts(
  db: ConflictDb,
  {
    actorMemberId,
    actorRole,
    checkIn,
    checkOut,
    guests,
    excludeBookingId,
  }: {
    actorMemberId: string;
    actorRole: string;
    checkIn: Date;
    checkOut: Date;
    guests: readonly ConflictGuestInput[];
    excludeBookingId?: string;
  },
): Promise<BookingMemberNightConflict[]> {
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const end = normalizeDateOnlyForTimeZone(checkOut);
  const requested = requestedNightsByMember(guests, start, end);
  const memberIds = [...requested.keys()];
  if (memberIds.length === 0) return [];

  const today = normalizeDateOnlyForTimeZone(new Date());
  const existingGuests = await db.bookingGuest.findMany({
    where: {
      memberId: { in: memberIds },
      booking: {
        deletedAt: null,
        checkIn: { lt: end },
        checkOut: { gt: start },
        status: { in: [...MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES] },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
        OR: [
          { status: { not: BookingStatus.DRAFT } },
          { draftExpiresAt: null },
          { draftExpiresAt: { gt: new Date() } },
        ],
      },
    },
    include: {
      nights: { select: { stayDate: true } },
      member: { select: { firstName: true, lastName: true } },
      booking: {
        select: {
          id: true,
          memberId: true,
          status: true,
          checkIn: true,
          checkOut: true,
          member: { select: { firstName: true, lastName: true } },
          guests: { select: { id: true, memberId: true } },
        },
      },
    },
  });

  const conflicts: BookingMemberNightConflict[] = [];

  for (const guest of existingGuests) {
    if (!guest.memberId) continue;
    const requestedNights = requested.get(guest.memberId);
    if (!requestedNights) continue;

    const bookingRange = {
      checkIn: guest.booking.checkIn,
      checkOut: guest.booking.checkOut,
    };
    const conflictingNights = [...requestedNights].filter((night) =>
      isGuestActiveOnNight(
        guest,
        normalizeDateOnlyForTimeZone(new Date(`${night}T00:00:00.000Z`)),
        bookingRange,
      ),
    );
    if (conflictingNights.length === 0) continue;

    const isOwnBooking = guest.booking.memberId === actorMemberId;
    const isSelfGuest = guest.memberId === actorMemberId;
    const canSelfRemove =
      !isOwnBooking &&
      isSelfGuest &&
      guest.booking.guests.length > 1 &&
      guest.booking.checkIn > today &&
      SELF_REMOVABLE_MEMBER_NIGHT_CONFLICT_STATUSES.has(guest.booking.status);

    conflicts.push({
      memberId: guest.memberId,
      memberName: displayName(
        guest.member?.firstName ?? guest.firstName,
        guest.member?.lastName ?? guest.lastName,
      ),
      bookingId: guest.booking.id,
      bookingStatus: guest.booking.status,
      bookingOwnerName: displayName(
        guest.booking.member.firstName,
        guest.booking.member.lastName,
      ),
      bookingCheckIn: formatDateOnly(guest.booking.checkIn),
      bookingCheckOut: formatDateOnly(guest.booking.checkOut),
      guestId: guest.id,
      conflictingNights: conflictingNights.sort(),
      isOwnBooking,
      canOpenBooking: isOwnBooking || actorRole === "ADMIN" || isSelfGuest,
      canSelfRemove,
    });
  }

  return conflicts.sort((a, b) => {
    const byNight = a.conflictingNights[0].localeCompare(b.conflictingNights[0]);
    if (byNight !== 0) return byNight;
    return a.memberName.localeCompare(b.memberName);
  });
}

export async function assertNoBookingMemberNightConflicts(
  db: ConflictDb,
  input: Parameters<typeof findBookingMemberNightConflicts>[1],
) {
  // #1881 — take the per-member advisory lock BEFORE the guard reads, so the
  // cross-lodge person-night invariant is serialised (capacity locks are
  // per-lodge only). This is the authoritative enforcement path and always runs
  // inside a transaction, so the lock is transaction-scoped and released on
  // commit/rollback. The advisory (non-authoritative) `findBookingMemberNight-
  // Conflicts` pre-check deliberately does NOT lock. If `db` is not a
  // lock-capable client (never the case for the authoritative callers, which
  // pass the transaction client), the guard still reads — this only adds the
  // cross-lodge serialisation, it never weakens the existing check.
  if (hasExecuteRaw(db)) {
    await lockBookingMemberNights(db, input.guests);
  }
  const conflicts = await findBookingMemberNightConflicts(db, input);
  if (conflicts.length > 0) {
    throw new BookingMemberNightConflictError(conflicts);
  }
}

export function getBookingMemberNightConflictResponse(
  conflicts: BookingMemberNightConflict[],
) {
  return {
    code: BOOKING_MEMBER_NIGHT_CONFLICT_CODE,
    error:
      conflicts.length === 1
        ? `${conflicts[0].memberName} is already on a booking for one of these nights.`
        : "One or more members are already on a booking for these nights.",
    conflicts,
  };
}
