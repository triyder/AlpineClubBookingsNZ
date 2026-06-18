/**
 * Group bookings (shareable join code).
 *
 * A member (the organiser) opens one of their own bookings as a private group
 * event and shares a short join code. Members and non-members open the
 * /join/[code] link and add themselves: each joiner becomes their own child
 * Booking linked to the organiser booking via Booking.parentBookingId (the
 * existing split-booking relation), so capacity, pricing, payment, and
 * cancellation all reuse the per-booking machinery.
 *
 * The organiser chooses, per group, whether each joiner pays for their own beds
 * (EACH_PAYS_OWN) or the organiser settles the whole bill and joiners are
 * registered at $0 (ORGANISER_PAYS). Joins are checked against remaining lodge
 * capacity at join time under the same advisory lock as every other creation
 * path; there is no pre-held block.
 *
 * Conventions (matching booking-request.ts):
 *   - money stays integer cents
 *   - booking dates stay NZ date-only values
 *   - only SHA-256 token hashes are stored (issueActionToken)
 *   - external calls (email) run after the transaction commits
 *
 * This module owns code generation, organiser create/manage, and public code
 * lookup. The join orchestration (member join, non-member verify, child booking
 * creation) builds on these in the route layer.
 */
import { randomInt } from "crypto";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createConfirmedBooking } from "@/lib/booking-create";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import { requiresPaidSubscriptionForBooking } from "@/lib/member-subscription-eligibility";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import { calculateBookingHoldDecision, toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getSeasonYear } from "@/lib/utils";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";

// Organiser booking states that may host a group. The organiser must be
// committed (their own beds already reserved) before opening the group to
// others, so we require a capacity-holding or payment-pending status.
const OPENABLE_ORGANISER_STATUSES: readonly string[] = [
  "PAID",
  "CONFIRMED",
  "PAYMENT_PENDING",
];

// Unambiguous uppercase charset (no I/L/O/0/1), shared with work party codes so
// a code is easy to read aloud and type. 31^8 is about 8.5e11 combinations.
const CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_GENERATION_ATTEMPTS = 5;

export class GroupBookingError extends Error {
  status: number;
  /** Optional machine-readable code mirrored from the bookings route gates. */
  code?: string;
  /** Optional extra payload (e.g. capacity-exceeded nights, unpaid members). */
  details?: unknown;

  constructor(
    message: string,
    status = 400,
    options?: { code?: string; details?: unknown }
  ) {
    super(message);
    this.name = "GroupBookingError";
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
  }
}

/**
 * Generate a short, human-typable join code. randomInt uses rejection sampling
 * so every character is chosen with equal probability (a `randomBytes % len`
 * approach would be subtly biased for a charset length that is not a power of
 * two), matching generateWorkPartyPromoCode in work-party.ts.
 */
export function generateGroupBookingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARSET[randomInt(0, CODE_CHARSET.length)];
  }
  return code;
}

/**
 * Normalise a code as entered by a person: trim, uppercase, and drop spaces and
 * dashes people add for readability. Lookups always normalise first.
 */
export function normaliseJoinCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}

function isJoinCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = err.meta?.target;
  const targets = Array.isArray(target) ? target : [target];
  return targets.some((t) => typeof t === "string" && t.includes("joinCode"));
}

// ---------------------------------------------------------------------------
// Organiser: create and manage
// ---------------------------------------------------------------------------

export interface CreateGroupBookingInput {
  organiserBookingId: string;
  paymentMode: GroupBookingPaymentMode;
  joinDeadline?: Date | null;
  maxJoiners?: number | null;
}

/**
 * Open a group on one of the caller's own bookings and generate a join code.
 * Retries on the (unlikely) code collision; a duplicate on organiserBookingId
 * means the booking already has a group.
 */
export async function createGroupBooking(
  input: CreateGroupBookingInput,
  sessionUserId: string
) {
  const booking = await prisma.booking.findUnique({
    where: { id: input.organiserBookingId },
    select: {
      id: true,
      memberId: true,
      status: true,
      deletedAt: true,
      parentBookingId: true,
      groupBookingAsOrganiser: { select: { id: true } },
    },
  });

  if (!booking || booking.deletedAt) {
    throw new GroupBookingError("Booking not found", 404);
  }
  if (booking.memberId !== sessionUserId) {
    throw new GroupBookingError(
      "You can only open a group on your own booking",
      403
    );
  }
  if (booking.parentBookingId) {
    throw new GroupBookingError(
      "This booking is part of another booking and cannot host a group",
      409
    );
  }
  if (!OPENABLE_ORGANISER_STATUSES.includes(booking.status)) {
    throw new GroupBookingError(
      "This booking is not in a state that can host a group",
      409
    );
  }
  if (booking.groupBookingAsOrganiser) {
    throw new GroupBookingError("This booking already has a group", 409);
  }
  if (input.joinDeadline && input.joinDeadline.getTime() <= Date.now()) {
    throw new GroupBookingError("Join deadline must be in the future", 400);
  }
  if (input.maxJoiners != null && input.maxJoiners < 1) {
    throw new GroupBookingError("Maximum joiners must be at least 1", 400);
  }

  for (let attempt = 1; attempt <= CODE_GENERATION_ATTEMPTS; attempt++) {
    try {
      return await prisma.groupBooking.create({
        data: {
          organiserBookingId: booking.id,
          organiserMemberId: booking.memberId,
          joinCode: generateGroupBookingCode(),
          paymentMode: input.paymentMode,
          joinDeadline: input.joinDeadline ?? null,
          maxJoiners: input.maxJoiners ?? null,
        },
      });
    } catch (err) {
      if (isJoinCodeCollision(err) && attempt < CODE_GENERATION_ATTEMPTS) {
        continue;
      }
      // A non-code unique violation here is the organiserBookingId guard losing
      // a race with a concurrent create for the same booking.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new GroupBookingError("This booking already has a group", 409);
      }
      throw err;
    }
  }
  throw new GroupBookingError(
    "Could not generate a unique join code, please try again",
    500
  );
}

async function requireOwnedGroupBookingByCode(
  rawCode: string,
  sessionUserId: string
) {
  const code = normaliseJoinCode(rawCode);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: { id: true, organiserMemberId: true, status: true },
      })
    : null;
  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (group.organiserMemberId !== sessionUserId) {
    throw new GroupBookingError("This is not your group booking", 403);
  }
  return group;
}

/** Close a group to new joins. Existing child bookings are untouched. */
export async function closeGroupBooking(rawCode: string, sessionUserId: string) {
  const group = await requireOwnedGroupBookingByCode(rawCode, sessionUserId);
  if (group.status === GroupBookingStatus.CANCELLED) {
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }
  return prisma.groupBooking.update({
    where: { id: group.id },
    data: { status: GroupBookingStatus.CLOSED },
  });
}

/** Reopen a closed group to new joins. */
export async function reopenGroupBooking(rawCode: string, sessionUserId: string) {
  const group = await requireOwnedGroupBookingByCode(rawCode, sessionUserId);
  if (group.status === GroupBookingStatus.CANCELLED) {
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }
  return prisma.groupBooking.update({
    where: { id: group.id },
    data: { status: GroupBookingStatus.OPEN },
  });
}

// ---------------------------------------------------------------------------
// Public: code lookup
// ---------------------------------------------------------------------------

export interface GroupBookingSummary {
  code: string;
  status: GroupBookingStatus;
  paymentMode: GroupBookingPaymentMode;
  organiserFirstName: string;
  checkIn: Date;
  checkOut: Date;
  joinDeadline: Date | null;
  isJoinable: boolean;
}

// Shape that resolveGroupBookingByCode selects from the database. Kept as a
// type so the pure shaping helper can be unit-tested without a database.
export interface GroupBookingRecordForSummary {
  joinCode: string;
  status: GroupBookingStatus;
  paymentMode: GroupBookingPaymentMode;
  joinDeadline: Date | null;
  organiserBooking: { checkIn: Date; checkOut: Date };
  organiserMember: { firstName: string };
}

/**
 * True when a group is accepting joins: it is OPEN and either has no deadline or
 * the deadline is still in the future. Re-checked inside the locked join
 * transaction; this is the read-side hint shown to a prospective joiner.
 */
export function isGroupJoinable(
  group: { status: GroupBookingStatus; joinDeadline: Date | null },
  now: Date = new Date()
): boolean {
  if (group.status !== GroupBookingStatus.OPEN) {
    return false;
  }
  return !group.joinDeadline || group.joinDeadline.getTime() > now.getTime();
}

/** Pure mapping from the selected record to the public-safe summary. */
export function toGroupBookingSummary(
  group: GroupBookingRecordForSummary,
  now: Date = new Date()
): GroupBookingSummary {
  return {
    code: group.joinCode,
    status: group.status,
    paymentMode: group.paymentMode,
    organiserFirstName: group.organiserMember.firstName,
    checkIn: group.organiserBooking.checkIn,
    checkOut: group.organiserBooking.checkOut,
    joinDeadline: group.joinDeadline,
    isJoinable: isGroupJoinable(group, now),
  };
}

/**
 * Public lookup by code. Returns a safe summary only (no member contact, no
 * booking ids, no roster), or null when the code is unknown. Returning null
 * uniformly avoids leaking which codes exist.
 */
export async function resolveGroupBookingByCode(
  rawCode: string
): Promise<GroupBookingSummary | null> {
  const code = normaliseJoinCode(rawCode);
  if (!code) {
    return null;
  }
  const group = await prisma.groupBooking.findUnique({
    where: { joinCode: code },
    select: {
      joinCode: true,
      status: true,
      paymentMode: true,
      joinDeadline: true,
      organiserBooking: { select: { checkIn: true, checkOut: true } },
      organiserMember: { select: { firstName: true } },
    },
  });
  if (!group) {
    return null;
  }
  return toGroupBookingSummary(group);
}

// ---------------------------------------------------------------------------
// Member self-add (join)
// ---------------------------------------------------------------------------

export interface JoinGroupBookingResult {
  bookingId: string;
  status: BookingStatus;
  isZeroDollarConfirmed: boolean;
  finalPriceCents: number;
  requiresPayment: boolean;
}

/**
 * A logged-in member adds themselves (and their own member guests) to a group.
 *
 * EACH_PAYS_OWN only for now: the joiner's beds become their own child booking
 * linked to the organiser booking via parentBookingId, created through
 * createConfirmedBooking so capacity (advisory lock), pricing, the $0
 * auto-confirm and the payment flow are all reused. The same eligibility gates
 * as POST /api/bookings are enforced (owner + guest subscriptions, minimum stay,
 * linked-member rules). ORGANISER_PAYS uses a different shared-draft flow and is
 * not handled here yet.
 *
 * Non-member friends use the public join-request path, so every guest here must
 * be a member; a non-member guest is rejected with a clear message.
 */
export async function joinGroupBookingAsMember(
  input: { code: string; guests: BookingGuestInput[] },
  sessionUserId: string,
  sessionRole: string
): Promise<JoinGroupBookingResult> {
  const code = normaliseJoinCode(input.code);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: {
          id: true,
          status: true,
          joinDeadline: true,
          paymentMode: true,
          maxJoiners: true,
          organiserMemberId: true,
          organiserBooking: {
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      })
    : null;

  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (!isGroupJoinable(group)) {
    throw new GroupBookingError("This group is not accepting joins", 409);
  }
  if (group.paymentMode !== GroupBookingPaymentMode.EACH_PAYS_OWN) {
    throw new GroupBookingError(
      "Joining an organiser-pays group is not available yet",
      409
    );
  }
  if (
    group.organiserBooking.deletedAt ||
    !(ACTIVE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      group.organiserBooking.status
    )
  ) {
    throw new GroupBookingError("This group's booking is no longer active", 409);
  }
  if (group.organiserMemberId === sessionUserId) {
    throw new GroupBookingError("You are the organiser of this group", 409);
  }

  // One active join per member.
  const existingJoin = await prisma.groupBookingJoin.findFirst({
    where: {
      groupBookingId: group.id,
      joinerMemberId: sessionUserId,
      booking: {
        is: {
          deletedAt: null,
          status: { notIn: [BookingStatus.CANCELLED, BookingStatus.BUMPED] },
        },
      },
    },
    select: { id: true },
  });
  if (existingJoin) {
    throw new GroupBookingError("You have already joined this group", 409);
  }

  // Optional organiser cap on headcount, independent of lodge capacity.
  if (group.maxJoiners != null) {
    const joinCount = await prisma.groupBookingJoin.count({
      where: { groupBookingId: group.id, bookingId: { not: null } },
    });
    if (joinCount >= group.maxJoiners) {
      throw new GroupBookingError("This group is full", 409);
    }
  }

  const { checkIn, checkOut } = group.organiserBooking;

  const joiner = await prisma.member.findUnique({
    where: { id: sessionUserId },
    select: { ageTier: true },
  });
  if (!joiner) {
    throw new GroupBookingError("Member not found", 404);
  }

  // Resolve and normalise guests against the joiner; members only here (non-member
  // friends join via the public path). Reuses the same helpers as the route.
  const linkedMembers = await resolveLinkedBookingMembers(
    prisma,
    sessionUserId,
    input.guests.map((g) => g.memberId)
  );
  await assertLinkedBookingMembersCanBeBooked(
    prisma,
    linkedMembers,
    sessionUserId,
    { actorRole: sessionRole, onBehalfOfMemberId: null }
  );
  const guests = normalizeBookingGuestInputs(input.guests, linkedMembers);
  if (guests.length === 0) {
    throw new GroupBookingError("Add at least one guest", 400);
  }
  if (guests.some((g) => !g.isMember)) {
    throw new GroupBookingError(
      "Only members can be added here. Non-member guests should use the public join link.",
      400
    );
  }

  const lodgeCapacity = await getLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    throw new GroupBookingError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400
    );
  }

  // Same eligibility gates as POST /api/bookings (skipped for admins).
  if (sessionRole !== "ADMIN") {
    if (await requiresPaidSubscriptionForBooking(joiner.ageTier)) {
      const seasonYear = getSeasonYear(checkIn);
      const paidSub = await prisma.memberSubscription.findFirst({
        where: { memberId: sessionUserId, seasonYear, status: "PAID" },
        select: { id: true },
      });
      if (!paidSub) {
        throw new GroupBookingError(
          `Your membership subscription for the ${seasonYear}/${seasonYear + 1} season is not paid. Please contact the club to arrange payment before joining.`,
          403,
          { code: "SUBSCRIPTION_REQUIRED" }
        );
      }
    }

    const unpaidMemberGuests = await findUnpaidMemberGuests(prisma, {
      bookingMemberId: sessionUserId,
      checkIn,
      guests,
    });
    if (unpaidMemberGuests.length > 0) {
      throw new GroupBookingError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests
          .map((m) => m.name)
          .join(", ")}.`,
        403,
        { code: "GUEST_SUBSCRIPTION_REQUIRED", details: unpaidMemberGuests }
      );
    }

    const { validateMinimumStay, formatViolationsDetail } = await import(
      "@/lib/booking-policies"
    );
    const stay = await validateMinimumStay(checkIn, checkOut);
    if (!stay.valid) {
      throw new GroupBookingError(
        "Booking does not meet the minimum stay requirement",
        400,
        {
          code: "MINIMUM_STAY_VIOLATION",
          details: formatViolationsDetail(stay.violations),
        }
      );
    }
  }

  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  const groupDiscount = toGroupDiscountConfig(gds);

  // All-member booking: no non-member hold; charged up front (PAYMENT_PENDING)
  // or auto-confirmed at $0 inside createConfirmedBooking.
  const hold = calculateBookingHoldDecision({
    hasNonMembers: false,
    checkIn,
    holdDays: 0,
  });

  const outcome = await createConfirmedBooking({
    effectiveMemberId: sessionUserId,
    isOnBehalf: false,
    sessionUserId,
    checkIn,
    checkOut,
    // Map to the booking-create guest shape. v1 joins use the organiser's dates
    // with no per-guest night selection, so only the scalar fields carry over.
    guests: guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    })),
    groupDiscount,
    status: hold.status,
    shouldBePending: hold.shouldBePending,
    holdDays: 0,
    parentBookingId: group.organiserBooking.id,
  });

  if (outcome.type === "capacityExceeded") {
    throw new GroupBookingError("The lodge is full for these dates", 409, {
      code: "CAPACITY_EXCEEDED",
      details: { fullNights: outcome.fullNights },
    });
  }

  const booking = outcome.booking;
  await prisma.groupBookingJoin.create({
    data: {
      groupBookingId: group.id,
      bookingId: booking.id,
      joinerMemberId: sessionUserId,
      isMember: true,
      verifiedAt: new Date(),
    },
  });

  return {
    bookingId: booking.id,
    status: booking.status,
    isZeroDollarConfirmed: outcome.isZeroDollarConfirmed,
    finalPriceCents: booking.finalPriceCents,
    requiresPayment:
      booking.status === BookingStatus.PAYMENT_PENDING &&
      booking.finalPriceCents > 0,
  };
}
