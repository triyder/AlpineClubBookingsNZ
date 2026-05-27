import { Prisma, PromoCodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculatePromoDiscount,
  selectPromoDiscountGuests,
  type PromoCodeInput,
  type PromoDiscountAllocation,
  type PromoDiscountGuest,
  type PromoDiscountResult,
} from "@/lib/pricing";

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type PromoUsageClient = typeof prisma | Prisma.TransactionClient;

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
  allocations?: PromoBeneficiaryAllocation[];
}

export interface PromoBeneficiaryAllocation {
  memberId: string;
  discountCents: number;
  freeNightsUsed: number;
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

export interface PromoApplicationSubject extends PromoRuleSubject {
  type: PromoCodeType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  memberGuestsOnly: boolean;
}

export interface PromoApplicationResult {
  error?: string;
  discount?: PromoDiscountResult;
  beneficiaryMemberIds: string[];
  remainingFreeNights?: number;
  remainingFreeNightsByMemberId?: Record<string, number>;
}

function hasAssignedMembers(assignedMemberIds: string[] | null | undefined) {
  return Boolean(assignedMemberIds && assignedMemberIds.length > 0);
}

function scopeGuestsForAssignedMembers(
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return guests;

  const assigned = new Set(assignedMemberIds);
  return guests.filter((guest) => Boolean(guest.memberId && assigned.has(guest.memberId)));
}

function normalizeAllocations(
  allocations: PromoDiscountAllocation[] | undefined,
  fallbackMemberId: string,
  discountCents: number,
  freeNightsUsed: number
): PromoBeneficiaryAllocation[] {
  const meaningfulAllocations = (allocations ?? []).filter(
    (allocation) => allocation.discountCents > 0 || allocation.freeNightsUsed > 0
  );

  if (meaningfulAllocations.length > 0) {
    return meaningfulAllocations.map((allocation) => ({
      memberId: allocation.memberId,
      discountCents: allocation.discountCents,
      freeNightsUsed: allocation.freeNightsUsed,
    }));
  }

  if (discountCents <= 0 && freeNightsUsed <= 0) return [];

  return [{
    memberId: fallbackMemberId,
    discountCents,
    freeNightsUsed,
  }];
}

/**
 * Calculate the promo discount for a booking using the per-guest model.
 * When the promo has member assignments, the benefit is restricted to linked
 * guest rows whose memberId is assigned. Unassigned promos keep the existing
 * booking-member beneficiary semantics for usage caps.
 */
export function calculatePromoDiscountForGuestRates(
  promo: PromoCodeInput,
  totalPriceCents: number,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null,
  remainingFreeNights?: number,
  remainingFreeNightsByMemberId?: Record<string, number>
): PromoDiscountResult {
  const assignedScoped = hasAssignedMembers(assignedMemberIds);
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);

  const result = calculatePromoDiscount(promo, {
    totalPriceCents,
    guests: scopedGuests,
    remainingFreeNights: assignedScoped && remainingFreeNightsByMemberId
      ? undefined
      : remainingFreeNights,
    remainingFreeNightsByMemberId: assignedScoped
      ? remainingFreeNightsByMemberId
      : undefined,
  });

  if (assignedScoped) {
    return result;
  }

  return {
    ...result,
    allocations: normalizeAllocations(
      [],
      bookingMemberId,
      result.discountCents,
      result.freeNightsUsed
    ),
  };
}

export function getPromoBeneficiaryMemberIds(
  promo: PromoCodeInput,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null
): string[] {
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);
  const selectedGuests = selectPromoDiscountGuests(promo, scopedGuests);
  if (selectedGuests.length === 0) return [];

  if (!hasAssignedMembers(assignedMemberIds)) {
    return [bookingMemberId];
  }

  return [...new Set(
    selectedGuests
      .map(({ guest }) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 */
export async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await db.promoRedemptionAllocation.aggregate({
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
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: { promoCodeId: string; bookingId?: { not: string } } = {
    promoCodeId,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }
  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return rows.length;
}

export async function getMemberPromoRedemptionCount(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  return db.promoRedemptionAllocation.count({ where });
}

async function getPromoBeneficiaryUsage(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
) {
  const usage: Record<string, { redemptionCount: number; freeNightsUsed: number }> = {};
  await Promise.all(
    [...new Set(memberIds)].map(async (memberId) => {
      const [redemptionCount, freeNightsUsed] = await Promise.all([
        getMemberPromoRedemptionCount(promoCodeId, memberId, excludeBookingId, db),
        getMemberFreeNightsUsed(promoCodeId, memberId, excludeBookingId, db),
      ]);
      usage[memberId] = { redemptionCount, freeNightsUsed };
    })
  );
  return usage;
}

async function getExistingBeneficiaryMemberIds(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
): Promise<Set<string>> {
  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length === 0) return new Set();

  const where: {
    promoCodeId: string;
    memberId: { in: string[] };
    bookingId?: { not: string };
  } = {
    promoCodeId,
    memberId: { in: uniqueMemberIds },
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return new Set(rows.map((row) => row.memberId));
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
          allocations: {
            where: { memberId },
            select: { id: true, freeNightsUsed: true },
          },
        },
      },
    },
  });

  return assignments.map((assignment) => {
    const promoCode = assignment.promoCode;
    const freeNightsUsed = promoCode.allocations.reduce(
      (sum, allocation) => sum + allocation.freeNightsUsed,
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
      redemptionCount: promoCode.allocations.length,
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
    allocations: Array<{ id: string; freeNightsUsed: number }>;
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
    promoCode.allocations.length >= promoCode.maxUsesPerMember
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
  requestedRedemptionCount?: number;
  requestedNewUniqueMemberCount?: number;
  memberRedemptionCounts?: Record<string, number>;
  memberFreeNightsUsedByMemberId?: Record<string, number>;
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
    promoCode.currentRedemptions + (counts.requestedRedemptionCount ?? 1) >
      promoCode.maxRedemptionsTotal
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
    counts.requestedNewUniqueMemberCount !== undefined &&
    (counts.uniqueMembersUsed ?? 0) + counts.requestedNewUniqueMemberCount >
      promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    counts.requestedNewUniqueMemberCount === undefined &&
    !counts.memberHasRedeemedBefore &&
    (counts.uniqueMembersUsed ?? 0) >= promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.maxUsesPerMember !== undefined &&
    counts.memberRedemptionCounts &&
    Object.values(counts.memberRedemptionCounts).some(
      (redemptionCount) => redemptionCount >= promoCode.maxUsesPerMember!
    )
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "A linked member guest has already used this promo code"
      : "A linked member guest has reached the maximum uses of this promo code";
  }

  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.maxUsesPerMember !== undefined &&
    !counts.memberRedemptionCounts &&
    (counts.memberRedemptionCount ?? 0) >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "You have already used this promo code"
      : "You have reached the maximum uses of this promo code";
  }

  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNightsPerIndividual &&
    counts.memberFreeNightsUsedByMemberId &&
    Object.values(counts.memberFreeNightsUsedByMemberId).some(
      (freeNightsUsed) => freeNightsUsed >= promoCode.freeNightsPerIndividual!
    )
  ) {
    return "A linked member guest has used all free nights for this promo code";
  }

  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNightsPerIndividual &&
    !counts.memberFreeNightsUsedByMemberId &&
    (counts.memberFreeNightsUsed ?? 0) >= promoCode.freeNightsPerIndividual
  ) {
    return "You have used all your free nights for this promo code";
  }

  return null;
}

export async function validateAndCalculatePromoDiscount(
  promoCode: PromoApplicationSubject | null,
  bookingDetails: BookingDetailsForPromo,
  assignedMemberIds: string[] | null = null,
  options: {
    excludeBookingId?: string;
    db?: PromoUsageClient;
    now?: Date;
  } = {}
): Promise<PromoApplicationResult> {
  if (!promoCode) {
    return {
      error: "Promo code not found",
      beneficiaryMemberIds: [],
    };
  }

  const db = options.db ?? prisma;
  const beneficiaryMemberIds = getPromoBeneficiaryMemberIds(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.memberId,
    bookingDetails.guests,
    assignedMemberIds
  );

  const beneficiaryUsage = await getPromoBeneficiaryUsage(
    promoCode.id,
    beneficiaryMemberIds,
    options.excludeBookingId,
    db
  );
  const bookerUsage = beneficiaryUsage[bookingDetails.memberId] ?? {
    redemptionCount: 0,
    freeNightsUsed: 0,
  };

  let uniqueMembersUsed = 0;
  let requestedNewUniqueMemberCount: number | undefined;
  if (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined) {
    uniqueMembersUsed = await getUniqueMemberRedemptionCount(
      promoCode.id,
      options.excludeBookingId,
      db
    );
    const existingBeneficiaries = await getExistingBeneficiaryMemberIds(
      promoCode.id,
      beneficiaryMemberIds,
      options.excludeBookingId,
      db
    );
    requestedNewUniqueMemberCount = beneficiaryMemberIds.filter(
      (memberId) => !existingBeneficiaries.has(memberId)
    ).length;
  }

  const memberRedemptionCounts = Object.fromEntries(
    beneficiaryMemberIds.map((memberId) => [
      memberId,
      beneficiaryUsage[memberId]?.redemptionCount ?? 0,
    ])
  );
  const memberFreeNightsUsedByMemberId = Object.fromEntries(
    beneficiaryMemberIds.map((memberId) => [
      memberId,
      beneficiaryUsage[memberId]?.freeNightsUsed ?? 0,
    ])
  );

  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    options.now ?? new Date(),
    {
      memberRedemptionCount: bookerUsage.redemptionCount,
      memberFreeNightsUsed: bookerUsage.freeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: bookerUsage.redemptionCount > 0,
      requestedRedemptionCount: beneficiaryMemberIds.length,
      requestedNewUniqueMemberCount,
      memberRedemptionCounts: beneficiaryMemberIds.length > 0
        ? memberRedemptionCounts
        : undefined,
      memberFreeNightsUsedByMemberId:
        promoCode.type === "FREE_NIGHTS" && beneficiaryMemberIds.length > 0
          ? memberFreeNightsUsedByMemberId
          : undefined,
    },
    assignedMemberIds
  );

  if (validationError) {
    return {
      error: validationError,
      beneficiaryMemberIds,
    };
  }

  const remainingFreeNightsByMemberId =
    promoCode.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual
      ? Object.fromEntries(
          beneficiaryMemberIds.map((memberId) => [
            memberId,
            promoCode.freeNightsPerIndividual! -
              (beneficiaryUsage[memberId]?.freeNightsUsed ?? 0),
          ])
        )
      : undefined;
  const assignedScoped = hasAssignedMembers(assignedMemberIds);
  const remainingFreeNights =
    !assignedScoped &&
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNightsPerIndividual
      ? promoCode.freeNightsPerIndividual - bookerUsage.freeNightsUsed
      : undefined;

  const discount = calculatePromoDiscountForGuestRates(
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
    remainingFreeNights,
    remainingFreeNightsByMemberId
  );

  return {
    discount,
    beneficiaryMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
  };
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

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const application = await validateAndCalculatePromoDiscount(
    promoCode,
    bookingDetails,
    assignedMemberIds,
    { excludeBookingId }
  );

  if (application.error || !application.discount) {
    return { valid: false, error: application.error ?? "Promo code could not be applied" };
  }

  const result = application.discount;

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
    remainingFreeNights: application.remainingFreeNights,
    allocations: result.allocations,
  };
}

/**
 * Create a PromoRedemption record and increment the promo code's currentRedemptions.
 * Should be called within a Prisma transaction.
 */
export async function redeemPromoCode(
  tx: PrismaTx,
  promoCodeId: string,
  bookingId: string,
  memberId: string,
  discountCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[]
): Promise<void> {
  const redemption = await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
      freeNightsUsed: freeNightsUsed ?? null,
      eligibleGuestCount: eligibleGuestCount ?? null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    memberId,
    discountCents,
    freeNightsUsed ?? 0
  );
  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId,
        bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: allocationData.length },
    },
  });
}

export async function replacePromoRedemptionAllocations(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string; bookingId: string; memberId: string },
  discountCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[]
): Promise<void> {
  const existingAllocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.update({
    where: { id: redemption.id },
    data: {
      discountCents,
      freeNightsUsed: freeNightsUsed || null,
      eligibleGuestCount: eligibleGuestCount || null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    redemption.memberId,
    discountCents,
    freeNightsUsed ?? 0
  );

  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId: redemption.promoCodeId,
        bookingId: redemption.bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }

  const delta = allocationData.length - existingAllocationCount;
  if (delta !== 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: {
        currentRedemptions: delta > 0
          ? { increment: delta }
          : { decrement: Math.abs(delta) },
      },
    });
  }
}

export async function deletePromoRedemptionAndAdjustCount(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string }
): Promise<void> {
  const allocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.delete({ where: { id: redemption.id } });

  if (allocationCount > 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: { currentRedemptions: { decrement: allocationCount } },
    });
  }
}
