import { PromoCodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculatePromoDiscount,
  type PromoCodeInput,
  type PromoDiscountGuest,
  type PromoDiscountResult,
} from "@/lib/pricing";

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  promoCode?: {
    id: string;
    code: string;
    description: string | null;
    type: PromoCodeType;
    valueCents: number | null;
    percentOff: number | null;
    freeNightsPerIndividual: number | null;
    maxGuestsPerBooking: number | null;
    maxNightlyValueCents: number | null;
    memberGuestsOnly: boolean;
  };
  discountCents?: number;
  freeNightsUsed?: number;
  eligibleGuestCount?: number;
  remainingFreeNights?: number;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: PromoCodeType;
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
}

export interface AssignedPromoCodeSummary extends AvailablePromoCode {
  id: string;
  assignedAt: Date | null;
  active: boolean;
  archivedAt: Date | null;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom: Date | null;
  bookingStartUntil: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  maxUsesPerMember: number | null;
  redemptionCount: number;
  freeNightsUsed: number;
  visibleToMember: boolean;
  statusReason: string;
}

export interface BookingDetailsForPromo {
  totalPriceCents: number;
  memberId: string;
  guests: PromoDiscountGuest[];
  bookingCheckIn?: Date;
}

/**
 * Calculate the promo discount for a booking using the per-guest model.
 * When the promo has member assignments and is a FREE_NIGHTS type, the
 * eligible guest set is further restricted to the booker's own guest rows
 * (preserves the prior assigned-member scoping behaviour).
 */
export function calculatePromoDiscountForGuestRates(
  promo: PromoCodeInput,
  totalPriceCents: number,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null,
  remainingFreeNights?: number
): PromoDiscountResult {
  const scopedGuests =
    promo.type === "FREE_NIGHTS" && assignedMemberIds && assignedMemberIds.length > 0
      ? guests.filter((g) => g.memberId === bookingMemberId)
      : guests;

  return calculatePromoDiscount(promo, {
    totalPriceCents,
    guests: scopedGuests,
    remainingFreeNights,
  });
}

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 */
export async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await prisma.promoRedemption.aggregate({
    where,
    _sum: { freeNightsUsed: true },
  });

  return result._sum.freeNightsUsed ?? 0;
}

/**
 * Count distinct members who have redeemed this promo code.
 * Excludes a specific booking id when updating an existing booking.
 */
export async function getUniqueMemberRedemptionCount(
  promoCodeId: string,
  excludeBookingId?: string
): Promise<number> {
  const where: { promoCodeId: string; bookingId?: { not: string } } = {
    promoCodeId,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }
  const rows = await prisma.promoRedemption.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return rows.length;
}

export async function getAvailablePromoCodesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AvailablePromoCode[]> {
  const assignedPromoCodes = await getAssignedPromoCodeSummariesForMember(memberId, now);

  return assignedPromoCodes
    .filter((promoCode) => promoCode.visibleToMember)
    .map((promoCode) => ({
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
    }));
}

export async function getAssignedPromoCodeSummariesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AssignedPromoCodeSummary[]> {
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId },
    include: {
      promoCode: {
        include: {
          redemptions: {
            where: { memberId },
            select: { id: true, freeNightsUsed: true },
          },
        },
      },
    },
  });

  return assignments.map((assignment) => {
    const promoCode = assignment.promoCode;
    const freeNightsUsed = promoCode.redemptions.reduce(
      (sum, redemption) => sum + (redemption.freeNightsUsed ?? 0),
      0
    );
    const statusReason = getAssignedPromoCodeStatusReason(promoCode, freeNightsUsed, now);

    return {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      assignedAt: assignment.createdAt ?? null,
      active: promoCode.active,
      archivedAt: promoCode.archivedAt,
      validFrom: promoCode.validFrom,
      validUntil: promoCode.validUntil,
      bookingStartFrom: promoCode.bookingStartFrom,
      bookingStartUntil: promoCode.bookingStartUntil,
      maxRedemptionsTotal: promoCode.maxRedemptionsTotal,
      currentRedemptions: promoCode.currentRedemptions,
      maxUsesPerMember: promoCode.maxUsesPerMember,
      redemptionCount: promoCode.redemptions.length,
      freeNightsUsed,
      visibleToMember: statusReason === null,
      statusReason: statusReason ?? "Available to member",
    };
  });
}

function getAssignedPromoCodeStatusReason(
  promoCode: {
    active: boolean;
    archivedAt: Date | null;
    validFrom: Date | null;
    validUntil: Date | null;
    maxRedemptionsTotal: number | null;
    currentRedemptions: number;
    maxUsesPerMember: number | null;
    type: PromoCodeType;
    freeNightsPerIndividual: number | null;
    redemptions: Array<{ id: string; freeNightsUsed: number | null }>;
  },
  freeNightsUsed: number,
  now: Date
) {
  if (!promoCode.active) return "Inactive";
  if (promoCode.archivedAt) return "Archived";
  if (promoCode.validFrom && now < promoCode.validFrom) return "Not valid yet";
  if (promoCode.validUntil && now >= promoCode.validUntil) return "Expired";
  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptionsTotal
  ) {
    return "Maximum uses reached";
  }
  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.redemptions.length >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "Already used by member"
      : "Maximum uses by member reached";
  }
  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNightsPerIndividual !== null &&
    freeNightsUsed >= promoCode.freeNightsPerIndividual
  ) {
    return "Free nights used";
  }
  return null;
}

/**
 * Promo rule shape used by pure validation. Booking-time callers and the
 * validate API both populate this from the locked PromoCode row.
 */
export interface PromoRuleSubject {
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom?: Date | null;
  bookingStartUntil?: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  maxUsesPerMember: number | null;
  maxUniqueMembersTotal: number | null;
  type?: PromoCodeType;
  freeNightsPerIndividual?: number | null;
}

export interface PromoRuleCounts {
  memberRedemptionCount?: number;
  memberFreeNightsUsed?: number;
  uniqueMembersUsed?: number;
  memberHasRedeemedBefore?: boolean;
}

/**
 * Validate promo code rules (pure logic, separated for testing).
 * Returns error message string if invalid, null if valid.
 */
export function validatePromoCodeRules(
  promoCode: PromoRuleSubject | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  now: Date = new Date(),
  counts: PromoRuleCounts = {},
  assignedMemberIds: string[] | null = null
): string | null {
  if (!promoCode) {
    return "Promo code not found";
  }

  if (!promoCode.active) {
    return "This promo code is no longer active";
  }

  if (promoCode.validFrom && now < promoCode.validFrom) {
    return "This promo code is not yet valid";
  }

  if (promoCode.validUntil && now >= promoCode.validUntil) {
    return "This promo code has expired";
  }

  if (bookingDetails.bookingCheckIn) {
    if (promoCode.bookingStartFrom && bookingDetails.bookingCheckIn < promoCode.bookingStartFrom) {
      return "This promo code is not valid for your booking dates";
    }
    if (promoCode.bookingStartUntil && bookingDetails.bookingCheckIn >= promoCode.bookingStartUntil) {
      return "This promo code is not valid for your booking dates";
    }
  }

  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptionsTotal
  ) {
    return "This promo code has reached its maximum number of uses";
  }

  if (promoCode.membersOnly && !bookingDetails.memberId) {
    return "This promo code is only available to members";
  }

  if (assignedMemberIds !== null && assignedMemberIds.length > 0) {
    if (!bookingDetails.memberId || !assignedMemberIds.includes(bookingDetails.memberId)) {
      return "This promo code is not assigned to you";
    }
  }

  // Cap on distinct members. Allow if the booker has already redeemed at
  // least once (they're counted), otherwise reject when the cap is hit.
  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    !counts.memberHasRedeemedBefore &&
    (counts.uniqueMembersUsed ?? 0) >= promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.maxUsesPerMember !== undefined &&
    (counts.memberRedemptionCount ?? 0) >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "You have already used this promo code"
      : "You have reached the maximum uses of this promo code";
  }

  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNightsPerIndividual &&
    (counts.memberFreeNightsUsed ?? 0) >= promoCode.freeNightsPerIndividual
  ) {
    return "You have used all your free nights for this promo code";
  }

  return null;
}

/**
 * Full validation including database lookups for caps and cumulative
 * free-night tracking. Use this in API routes where you need the full
 * validation and discount calculation.
 */
export async function validatePromoCodeFull(
  code: string,
  bookingDetails: BookingDetailsForPromo,
  excludeBookingId?: string
): Promise<PromoValidationResult> {
  const normalizedCode = code.toUpperCase().trim();

  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
    include: { assignments: { select: { memberId: true } } },
  });

  if (!promoCode) {
    return { valid: false, error: "Promo code not found" };
  }

  // Count this member's prior redemptions (used for both maxUsesPerMember and
  // the "already redeemed -> counts as existing" branch of maxUniqueMembersTotal).
  const memberWhere: { promoCodeId: string; memberId: string; bookingId?: { not: string } } = {
    promoCodeId: promoCode.id,
    memberId: bookingDetails.memberId,
  };
  if (excludeBookingId) {
    memberWhere.bookingId = { not: excludeBookingId };
  }
  const memberRedemptionCount = await prisma.promoRedemption.count({ where: memberWhere });

  let uniqueMembersUsed = 0;
  if (promoCode.maxUniqueMembersTotal !== null) {
    uniqueMembersUsed = await getUniqueMemberRedemptionCount(promoCode.id, excludeBookingId);
  }

  let memberFreeNightsUsed = 0;
  if (promoCode.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual) {
    memberFreeNightsUsed = await getMemberFreeNightsUsed(
      promoCode.id,
      bookingDetails.memberId,
      excludeBookingId
    );
  }

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    new Date(),
    {
      memberRedemptionCount,
      memberFreeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: memberRedemptionCount > 0,
    },
    assignedMemberIds
  );

  if (validationError) {
    return { valid: false, error: validationError };
  }

  const remainingFreeNights = promoCode.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual
    ? promoCode.freeNightsPerIndividual - memberFreeNightsUsed
    : undefined;

  const result = calculatePromoDiscountForGuestRates(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.totalPriceCents,
    bookingDetails.memberId,
    bookingDetails.guests,
    assignedMemberIds,
    remainingFreeNights
  );

  return {
    valid: true,
    promoCode: {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    discountCents: result.discountCents,
    freeNightsUsed: result.freeNightsUsed,
    eligibleGuestCount: result.eligibleGuestCount,
    remainingFreeNights,
  };
}

/**
 * Create a PromoRedemption record and increment the promo code's currentRedemptions.
 * Should be called within a Prisma transaction.
 */
export async function redeemPromoCode(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  promoCodeId: string,
  bookingId: string,
  memberId: string,
  discountCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number
): Promise<void> {
  await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
      freeNightsUsed: freeNightsUsed ?? null,
      eligibleGuestCount: eligibleGuestCount ?? null,
    },
  });

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: 1 },
    },
  });
}
