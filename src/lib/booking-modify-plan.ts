// Split out of src/lib/booking-modify.ts (issue #1138): the in-transaction
// modification pipeline — guest plan, repricing, promo changes, change fee,
// and guest/chore writes. Kept together because the booking-guest-profile
// gate contract test compares string indexes across this pipeline in one
// file. Code moved verbatim; import via the "@/lib/booking-modify" barrel.

import {
  AdminReviewStatus,
  type AgeTier,
  type BookingGuest,
  type Prisma,
  type PromoCode,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  applyMembershipTypeRatePolicyToGuests,
  assertMembershipTypeBookingAllowed,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import {
  deletePromoRedemptionAndAdjustCount,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import { isLikelyTypoCorrection } from "@/lib/guest-name-similarity";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getSeasonYear } from "@/lib/utils";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import {
  BookingModifyReviewJustificationRequiredError,
  getGuestStayRangeInputMap,
  hasGuestStayRangeInputs,
  hasStayRangeInput,
  isBookingFullyPaidForGuestNameEdits,
  normalizeRangeOrApiError,
  type BatchModifyInput,
  type LoadedBookingForModify,
  type LoadedPromoRedemption,
} from "@/lib/booking-modify-validation";

type ProposedGuestPricingInput = {
  bookingGuestId?: string | null;
  ageTier: AgeTier;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
};

type ProposedRemainingGuest = {
  guest: BookingGuest & { nights?: { stayDate: Date; priceCents?: number }[] };
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
};

function normalizeRangesOrApiError<Guest extends { stayStart?: string | Date | null; stayEnd?: string | Date | null }>(
  guests: Guest[],
  booking: { checkIn: Date; checkOut: Date }
) {
  try {
    return normalizeGuestStayRanges(guests, booking);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

/**
 * The guest's stored per-night prices, usable as `lockedNightPrices` (#1036).
 * Rows loaded without `priceCents` (or legacy guests without night rows)
 * yield no locks, so those nights price at current season rates.
 */
export function lockedNightPricesForGuest(guest: {
  nights?: { stayDate: Date; priceCents?: number }[];
}): Array<{ stayDate: Date; priceCents: number }> {
  return (guest.nights ?? []).flatMap((night) =>
    typeof night.priceCents === "number"
      ? [{ stayDate: night.stayDate, priceCents: night.priceCents }]
      : [],
  );
}

export type ResolvedGuestNameUpdate = {
  guestId: string;
  firstName: string;
  lastName: string;
  previousFirstName: string;
  previousLastName: string;
};

/**
 * Shown when a free-text non-member guest name edit on a fully-paid booking is
 * NOT an identity-preserving spelling correction (#1386). The paid-name lock
 * still blocks swapping in a different person; only typo fixes are exempt.
 */
export const PAID_NAME_TYPO_ONLY_MESSAGE =
  "Only spelling corrections are allowed after payment; to change who a booking is for, contact the office.";

function normalizeGuestName(value: string, fieldName: string) {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) {
    throw new ApiError(`${fieldName} is required`, 400);
  }
  if (normalized.length > 100) {
    throw new ApiError(`${fieldName} must be 100 characters or fewer`, 400);
  }
  return normalized;
}

export function resolveGuestNameUpdates({
  booking,
  input,
  allowWhenFullyPaid = false,
  allowTypoFixWhenFullyPaid = false,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "guests" | "status" | "finalPriceCents" | "payment"
  >;
  input: Pick<BatchModifyInput, "guestUpdates" | "removeGuestIds">;
  /**
   * Quoted (booking-request) bookings are exempt from the paid-name lock
   * (#1099): their guests are placeholder records ("School Child 1..N") and
   * replacing them with real attendee names before arrival is the intended
   * workflow — including after the school has paid its invoice.
   */
  allowWhenFullyPaid?: boolean;
  /**
   * Identity-only edits (no structural change) on a fully-paid booking may fix
   * an identity-preserving spelling TYPO on a free-text non-member guest
   * (#1386). Each changed name must pass {@link isLikelyTypoCorrection}; the
   * lock still rejects anything that could be a different person (a swap).
   * Ignored when {@link allowWhenFullyPaid} already lifts the lock (quoted
   * bookings), and irrelevant when the booking is not fully paid.
   */
  allowTypoFixWhenFullyPaid?: boolean;
}): ResolvedGuestNameUpdate[] {
  if (!input.guestUpdates?.length) {
    return [];
  }

  const fullyPaidLockActive =
    !allowWhenFullyPaid && isBookingFullyPaidForGuestNameEdits(booking);

  if (fullyPaidLockActive && !allowTypoFixWhenFullyPaid) {
    throw new ApiError(
      "Non-member guest names cannot be edited after the booking is fully paid",
      400,
    );
  }

  const removedGuestIds = new Set(input.removeGuestIds ?? []);
  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const seenGuestIds = new Set<string>();
  const updates: ResolvedGuestNameUpdate[] = [];

  for (const update of input.guestUpdates) {
    if (seenGuestIds.has(update.guestId)) {
      throw new ApiError("Each guest can only be updated once", 400);
    }
    seenGuestIds.add(update.guestId);

    if (removedGuestIds.has(update.guestId)) {
      throw new ApiError(
        "A guest cannot be renamed and removed in the same change",
        400,
      );
    }

    const guest = guestsById.get(update.guestId);
    if (!guest) {
      throw new ApiError(
        "One or more guest updates referenced a guest not found on this booking",
        400,
      );
    }

    if (guest.isMember || guest.memberId) {
      throw new ApiError("Member guest names cannot be edited on a booking", 400);
    }

    const firstName = normalizeGuestName(update.firstName, "First name");
    const lastName = normalizeGuestName(update.lastName, "Last name");
    if (firstName === guest.firstName && lastName === guest.lastName) {
      continue;
    }

    // On a fully-paid booking the lock is only lifted for an identity-preserving
    // spelling correction (#1386); a name that could be a different person keeps
    // the hard reject so payment can't quietly transfer the booking.
    if (
      fullyPaidLockActive &&
      !isLikelyTypoCorrection(
        guest.firstName,
        guest.lastName,
        firstName,
        lastName,
      )
    ) {
      throw new ApiError(PAID_NAME_TYPO_ONLY_MESSAGE, 400);
    }

    updates.push({
      guestId: guest.id,
      firstName,
      lastName,
      previousFirstName: guest.firstName,
      previousLastName: guest.lastName,
    });
  }

  return updates;
}

export type GuestPlan = {
  remainingGuests: BookingGuest[];
  proposedRemainingGuests: ProposedRemainingGuest[];
  removedGuests: BookingGuest[];
  normalizedAddGuests: BookingGuestInput[] | undefined;
  guestsForPricing: ProposedGuestPricingInput[];
  totalGuestCount: number;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  /**
   * Review-related fields to write to the booking after the modification.
   * Encapsulates four scenarios: rule clears (fields nulled), rule trips
   * for the first time on a member modification (justification captured,
   * adminReviewStatus = PENDING), rule trips on an admin modification
   * (auto-approved), rule already tripped (existing review state kept).
   */
  reviewUpdate: {
    requiresAdminReview: boolean;
    adminReviewReason: string | null;
    memberReviewJustification: string | null;
    adminReviewStatus: AdminReviewStatus | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
    /** When true, status must move to AWAITING_REVIEW unless already there. */
    parkForReview: boolean;
    /** When true, AWAITING_REVIEW should be released to PAYMENT_PENDING. */
    releaseFromReview: boolean;
  };
};

export async function prepareGuestPlan(
  tx: Prisma.TransactionClient,
  {
    booking,
    role,
    actorId,
    input,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
  }: {
    booking: LoadedBookingForModify;
    role: Role;
    actorId: string;
    input: BatchModifyInput;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
  },
): Promise<GuestPlan> {
  const linkedMembers = await resolveLinkedBookingMembers(
    tx,
    booking.memberId,
    (input.addGuests ?? []).map((guest) => guest.memberId),
    { skipAuthorization: role === "ADMIN" },
  );
  await assertLinkedBookingMembersCanBeBooked(tx, linkedMembers, actorId, {
    actorRole: role,
    onBehalfOfMemberId: role === "ADMIN" ? booking.memberId : null,
  });
  const normalizedAddGuests = input.addGuests
    ? normalizeBookingGuestInputs(input.addGuests, linkedMembers).map((guest, index) => ({
        ...guest,
        stayStart: input.addGuests?.[index]?.stayStart ?? null,
        stayEnd: input.addGuests?.[index]?.stayEnd ?? null,
        nights: input.addGuests?.[index]?.nights ?? null,
      }))
    : undefined;

  const removeSet = new Set(input.removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    throw new ApiError("Booking must have at least one guest", 400);
  }

  const hasRangeInputs = hasGuestStayRangeInputs(input);
  const datesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();
  const existingRangeInputs = getGuestStayRangeInputMap(input);
  // Preserve an unedited guest's existing night set (issue #713) so editing
  // one guest (or only names/notes/promo) never collapses another guest's gaps.
  const existingNightsFor = (guest: BookingGuest & { nights?: { stayDate: Date }[] }) =>
    guest.nights && guest.nights.length > 0
      ? guest.nights.map((night) => night.stayDate)
      : undefined;

  const proposedRemainingGuests: ProposedRemainingGuest[] = remainingGuests.map((guest, index) => {
    if (!hasRangeInputs) {
      // A booking date change resets each guest to the full new range (existing
      // behaviour); otherwise keep the guest exactly as stored, gaps included.
      return datesChanged
        ? { guest, stayStart: newCheckIn, stayEnd: newCheckOut }
        : {
            guest,
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            nights: existingNightsFor(guest),
          };
    }

    const rangeInput = existingRangeInputs.get(guest.id);
    const normalizedRange =
      rangeInput && hasStayRangeInput(rangeInput)
        ? normalizeRangeOrApiError(rangeInput, { checkIn: newCheckIn, checkOut: newCheckOut }, index)
        : {
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            nights: existingNightsFor(guest),
          };

    return { guest, ...normalizedRange };
  });

  const normalizedAddGuestsWithRanges = normalizedAddGuests
    ? normalizeRangesOrApiError(normalizedAddGuests, {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
      })
    : undefined;

  const guestsForPricing = [
    ...proposedRemainingGuests.map((entry) => ({
      bookingGuestId: entry.guest.id,
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights,
      // Nights the guest already bought keep their booked price (#1036);
      // only nights outside the stored set price at current season rates.
      lockedNightPrices: lockedNightPricesForGuest(entry.guest),
    })),
    ...(normalizedAddGuestsWithRanges ?? []).map((g) => ({
      bookingGuestId: null,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
    })),
  ];

  const totalGuestCount = guestsForPricing.length;
  const lodgeCapacity = await getLodgeCapacity(tx);
  if (totalGuestCount > lodgeCapacity) {
    throw new ApiError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400,
    );
  }

  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: actorId,
    actorRole: role,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: guestsForPricing,
    excludeBookingId: booking.id,
  });

  const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

  const reviewUpdate = resolveModifyReviewUpdate({
    booking,
    role,
    actorId,
    nowFlagged: requiresAdminReview,
    memberReviewJustification: input.memberReviewJustification,
  });

  if (role !== "ADMIN") {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
      guests: normalizedAddGuests ?? [],
    });
    if (unpaidMemberGuests.length > 0) {
      throw new ApiError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
        403,
      );
    }
  }

  return {
    remainingGuests,
    proposedRemainingGuests,
    removedGuests,
    normalizedAddGuests: normalizedAddGuestsWithRanges,
    guestsForPricing,
    totalGuestCount,
    requiresAdminReview,
    adminReviewReason,
    reviewUpdate,
  };
}

function resolveModifyReviewUpdate({
  booking,
  role,
  actorId,
  nowFlagged,
  memberReviewJustification,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  actorId: string;
  nowFlagged: boolean;
  memberReviewJustification: string | undefined;
}): GuestPlan["reviewUpdate"] {
  const wasFlagged = booking.requiresAdminReview;
  const existingStatus = booking.adminReviewStatus;
  const justification = memberReviewJustification?.trim();

  if (!nowFlagged) {
    // Rule cleared. Wipe review state so the booking returns to the
    // normal lifecycle; if it was parked in AWAITING_REVIEW, release it.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === "AWAITING_REVIEW",
    };
  }

  // Still flagged after modification. If review already happened (or is
  // pending), preserve it — admins should not be re-prompted for the same
  // booking just because the guest list shuffled.
  if (wasFlagged && existingStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification:
        justification ?? booking.memberReviewJustification ?? null,
      adminReviewStatus: existingStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: existingStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First time the rule has tripped on this booking.
  if (role === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: justification ?? null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at modification by admin.",
      adminReviewedById: actorId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  if (!justification) {
    throw new BookingModifyReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function loadActiveSeasonRates(
  tx: Prisma.TransactionClient,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true },
    include: { rates: true },
  });
  return seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));
}

export type PricingResult = {
  inProgressPlan: BookingEditGuestRangePlan | null;
  newTotalPriceCents: number;
  priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[]; nightDates: Date[] }>;
  };
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    nightDates?: Date[];
  }>;
};

/**
 * Build a per-night breakdown for a contiguous range by splitting the total
 * evenly across the nights, with any integer-cent remainder on the earliest
 * nights so the per-night sum equals the total exactly. Used by the
 * in-progress edit plan, which prices guests as scalar totals (issue #713).
 */
function splitContiguousNights(
  stayStart: Date,
  stayEnd: Date,
  totalCents: number
): { priceCents: number; perNightCents: number[]; nightDates: Date[] } {
  const nightDates = eachDateOnlyInRange(
    normalizeDateOnlyForTimeZone(stayStart),
    normalizeDateOnlyForTimeZone(stayEnd)
  );
  const count = nightDates.length;
  const perNightCents: number[] = [];
  if (count > 0) {
    const base = Math.floor(totalCents / count);
    const remainder = totalCents - base * count;
    for (let i = 0; i < count; i++) {
      perNightCents.push(base + (i < remainder ? 1 : 0));
    }
  }
  return { priceCents: totalCents, perNightCents, nightDates };
}

export async function calculateModifiedPricing(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    normalizedAddGuests,
    removeGuestIds,
    guestsForPricing,
    skipBookingLifecycleRules,
    seasonRateData,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    normalizedAddGuests: BookingGuestInput[] | undefined;
    removeGuestIds: string[] | undefined;
    guestsForPricing: Array<{
      bookingGuestId?: string | null;
      ageTier: AgeTier;
      isMember: boolean;
      memberId: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: Date[];
      lockedNightPrices?: ReadonlyArray<{
        stayDate: Date | string;
        priceCents: number;
      }> | null;
    }>;
    skipBookingLifecycleRules: boolean;
    seasonRateData: SeasonRateData[];
  },
): Promise<PricingResult> {
  const seasonYear = getSeasonYear(newCheckIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
  });

  const policyAdjustedGuestsForPricing = await applyMembershipTypeRatePolicyToGuests(tx, {
    seasonYear,
    guests: guestsForPricing,
  });
  const policyAdjustedAddGuests = normalizedAddGuests
    ? await applyMembershipTypeRatePolicyToGuests(tx, {
        seasonYear,
        guests: normalizedAddGuests,
      })
    : undefined;
  const policyAdjustedExistingGuests = await applyMembershipTypeRatePolicyToGuests(tx, {
    seasonYear,
    guests: booking.guests.map((guest) => ({
      ...guest,
      ageTier: guest.ageTier as AgeTier,
    })),
  });

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  if (isInProgressEdit && editableFrom) {
    inProgressPlan = buildInProgressGuestRangePlan({
      booking: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
        guests: policyAdjustedExistingGuests,
      },
      editableFrom,
      newCheckOut,
      addGuests: policyAdjustedAddGuests,
      removeGuestIds,
      seasons: seasonRateData,
    });
  }

  const capacity = skipBookingLifecycleRules
    ? { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] }
    : inProgressPlan && editableFrom
      ? await checkCapacityForGuestRanges(
          editableFrom,
          newCheckOut,
          inProgressPlan.capacityGuestRanges,
          bookingId,
          tx,
        )
      : await checkCapacityForGuestRanges(
          newCheckIn,
          newCheckOut,
          policyAdjustedGuestsForPricing,
          bookingId,
          tx,
        );
  if (!capacity.available) {
    throw new ApiError("Not enough beds available for these changes", 400);
  }

  let priceBreakdown: PricingResult["priceBreakdown"];
  try {
    priceBreakdown = inProgressPlan
      ? {
          totalPriceCents: inProgressPlan.newTotalPriceCents,
          guests: [
            ...inProgressPlan.proposedExistingGuests.map((entry) =>
              splitContiguousNights(entry.stayStart, entry.stayEnd, entry.priceCents)
            ),
            ...inProgressPlan.proposedAddedGuests.map((entry) =>
              splitContiguousNights(entry.stayStart, entry.stayEnd, entry.priceCents)
            ),
          ],
        }
      : await priceBookingGuestsWithMembershipTypePolicy(tx, {
          ownerMemberId: booking.memberId,
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          guests: policyAdjustedGuestsForPricing,
          seasons: seasonRateData,
          // Group discount applies to the newly priced nights (#1095); locked
          // nights keep their booked (discount-inclusive) prices regardless.
          groupDiscount: toGroupDiscountConfig(
            await tx.groupDiscountSetting.findUnique({
              where: { id: "default" },
            }),
          ),
          seasonYear,
        });
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      throw error;
    }
    throw new ApiError("No season rate found for the requested dates", 400);
  }

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const guestNightRates = inProgressPlan
    ? []
    : guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        bookingGuestId: guest.bookingGuestId ?? null,
        isMember: guest.isMember,
        perNightRates: priceBreakdown.guests[index]?.perNightCents ?? [],
        // Dates the positional rates so internal work-party promos restrict
        // the discount to the event's night window — correct for gaps too.
        firstNight: guest.stayStart ?? newCheckIn,
        nightDates: priceBreakdown.guests[index]?.nightDates ?? [],
      }));

  return {
    inProgressPlan,
    newTotalPriceCents,
    priceBreakdown,
    guestNightRates,
  };
}

export type PromoChangeResult = {
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
};

function promoRequiresStoredGuestTargets(
  promo: PromoCode & { assignments: Array<{ memberId: string }> }
) {
  return promo.assignments.length > 0 && promo.assignedMembersOnlyOwnNights === false;
}

function selectedIndexesForStoredGuestTargets(
  redemption: LoadedPromoRedemption,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption.promoCode)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

export async function applyPromoCodeChanges(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    input,
    inProgressPlan,
    newCheckIn,
    newTotalPriceCents,
    guestNightRates,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    input: BatchModifyInput;
    inProgressPlan: BookingEditGuestRangePlan | null;
    newCheckIn: Date;
    newTotalPriceCents: number;
    guestNightRates: Array<{
      bookingGuestId?: string | null;
      memberId: string | null;
      isMember: boolean;
      perNightRates: number[];
    }>;
  },
): Promise<PromoChangeResult> {
  if (inProgressPlan) {
    return {
      newDiscountCents: inProgressPlan.newDiscountCents,
      newPromoAdjustmentCents: inProgressPlan.newPromoAdjustmentCents,
      promoRemoved: false,
      promoChanged: false,
    };
  }

  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoChanged = false;

  if (input.removePromoCode && booking.promoRedemption) {
    await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    promoRemoved = true;
  }

  if (input.promoCode && !input.removePromoCode) {
    if (booking.promoRedemption && !promoRemoved) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    }

    const promoCode = await tx.promoCode.findUnique({
      where: { code: input.promoCode.toUpperCase().trim() },
      include: { assignments: { select: { memberId: true } } },
    });

    // Internal promos (work party events) cannot be entered as codes.
    if (!promoCode || promoCode.internal) {
      throw new ApiError("Promo code not found", 400);
    }

    const assignedMemberIds = promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null;
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes: input.promoGuestIndexes,
      },
    );
    if (application.error || !application.discount) {
      throw new ApiError(application.error ?? "Promo code could not be applied", 400);
    }

    const promoResult = application.discount;
    newDiscountCents = promoResult.discountCents;
    newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

    if (shouldPersistPromoRedemption(promoResult)) {
      await redeemPromoCode(
        tx,
        promoCode.id,
        bookingId,
        booking.memberId,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
    promoChanged = true;
  } else if (
    !input.removePromoCode &&
    !promoRemoved &&
    booking.promoRedemption?.promoCode
  ) {
    const promo = booking.promoRedemption.promoCode;
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      { excludeBookingId: bookingId, db: tx, selectedGuestIndexes },
    );

    if (application.error || !application.discount) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved, promoChanged };
}

export async function calculateModificationChangeFee({
  booking,
  newCheckIn,
  checkInChanged,
  skipBookingLifecycleRules,
}: {
  booking: LoadedBookingForModify;
  newCheckIn: Date;
  checkInChanged: boolean;
  skipBookingLifecycleRules: boolean;
}): Promise<number> {
  if (skipBookingLifecycleRules || !checkInChanged) {
    return 0;
  }
  const now = new Date();
  const policy = await loadCancellationPolicy(booking.checkIn);
  const feeResult = calculateChangeFee({
    daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
    daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
    originalFinalPriceCents: booking.finalPriceCents,
    policyRules: policy,
  });
  return feeResult.feeCents;
}

export async function applyGuestChanges(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    removedGuests,
    remainingGuests,
    proposedRemainingGuests,
    normalizedAddGuests,
    guestNameUpdates,
    priceBreakdown,
    inProgressPlan,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    removedGuests: BookingGuest[];
    remainingGuests: BookingGuest[];
    proposedRemainingGuests: ProposedRemainingGuest[];
    normalizedAddGuests: BookingGuestInput[] | undefined;
    guestNameUpdates?: ResolvedGuestNameUpdate[];
    priceBreakdown: PricingResult["priceBreakdown"];
    inProgressPlan: BookingEditGuestRangePlan | null;
  },
): Promise<{ createdGuests: BookingGuest[] }> {
  const createdGuests: BookingGuest[] = [];
  const nameUpdatesByGuestId = new Map(
    (guestNameUpdates ?? []).map((update) => [update.guestId, update]),
  );

  type BreakdownGuest = { nightDates: Date[]; perNightCents: number[] };

  // Re-sync a guest's BookingGuestNight rows to the priced nights (issue #713),
  // and return the matching stayStart/stayEnd envelope. Called on every guest
  // write so a guest's gaps are persisted and stale nights never linger.
  const syncGuestNights = async (
    bookingGuestId: string,
    bg: BreakdownGuest | undefined,
    fallbackStart: Date,
    fallbackEnd: Date,
  ): Promise<{ stayStart: Date; stayEnd: Date }> => {
    await tx.bookingGuestNight.deleteMany({ where: { bookingGuestId } });
    const nightDates = bg?.nightDates ?? [];
    if (nightDates.length > 0) {
      await tx.bookingGuestNight.createMany({
        data: nightDates.map((stayDate, k) => ({
          bookingGuestId,
          stayDate,
          priceCents: bg?.perNightCents[k] ?? 0,
        })),
      });
      return {
        stayStart: nightDates[0],
        stayEnd: addDaysDateOnly(nightDates[nightDates.length - 1], 1),
      };
    }
    return { stayStart: fallbackStart, stayEnd: fallbackEnd };
  };

  if (inProgressPlan) {
    const existingCount = inProgressPlan.proposedExistingGuests.length;
    for (let e = 0; e < existingCount; e++) {
      const entry = inProgressPlan.proposedExistingGuests[e];
      const nameUpdate = nameUpdatesByGuestId.get(entry.guest.id);
      const envelope = await syncGuestNights(
        entry.guest.id,
        priceBreakdown.guests[e],
        entry.stayStart,
        entry.stayEnd,
      );
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: {
          ...(nameUpdate
            ? {
                firstName: nameUpdate.firstName,
                lastName: nameUpdate.lastName,
              }
            : {}),
          stayStart: envelope.stayStart,
          stayEnd: envelope.stayEnd,
          priceCents: entry.priceCents,
        },
      });
    }

    for (let a = 0; a < inProgressPlan.proposedAddedGuests.length; a++) {
      const entry = inProgressPlan.proposedAddedGuests[a];
      const g = entry.guest;
      const guest = await tx.bookingGuest.create({
        data: {
          bookingId,
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId || null,
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
        },
      });
      const envelope = await syncGuestNights(
        guest.id,
        priceBreakdown.guests[existingCount + a],
        entry.stayStart,
        entry.stayEnd,
      );
      if (
        envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
        envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
      ) {
        await tx.bookingGuest.update({
          where: { id: guest.id },
          data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
        });
      }
      createdGuests.push(guest);
    }

    return { createdGuests };
  }

  for (const guest of removedGuests) {
    await tx.choreAssignment.deleteMany({
      where: { bookingGuestId: guest.id },
    });
    // BookingGuestNight rows cascade-delete with the guest.
    await tx.bookingGuest.delete({ where: { id: guest.id } });
  }

  const addedGuestStartIndex = remainingGuests.length;
  const addList = normalizedAddGuests ?? [];
  for (let i = 0; i < addList.length; i++) {
    const g = addList[i];
    const guestPriceIndex = addedGuestStartIndex + i;
    const bg = priceBreakdown.guests[guestPriceIndex];
    const guest = await tx.bookingGuest.create({
      data: {
        bookingId,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId || null,
        stayStart: g.stayStart ?? newCheckIn,
        stayEnd: g.stayEnd ?? newCheckOut,
        priceCents: bg.priceCents,
      },
    });
    const envelope = await syncGuestNights(
      guest.id,
      bg,
      newCheckIn,
      newCheckOut,
    );
    if (
      envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
      envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
    ) {
      await tx.bookingGuest.update({
        where: { id: guest.id },
        data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
      });
    }
    createdGuests.push(guest);
  }

  for (let i = 0; i < remainingGuests.length; i++) {
    const proposedRange = proposedRemainingGuests[i];
    const nameUpdate = nameUpdatesByGuestId.get(remainingGuests[i].id);
    const envelope = await syncGuestNights(
      remainingGuests[i].id,
      priceBreakdown.guests[i],
      proposedRange?.stayStart ?? newCheckIn,
      proposedRange?.stayEnd ?? newCheckOut,
    );
    await tx.bookingGuest.update({
      where: { id: remainingGuests[i].id },
      data: {
        ...(nameUpdate
          ? {
              firstName: nameUpdate.firstName,
              lastName: nameUpdate.lastName,
            }
          : {}),
        stayStart: envelope.stayStart,
        stayEnd: envelope.stayEnd,
        priceCents: priceBreakdown.guests[i].priceCents,
      },
    });
  }

  return { createdGuests };
}

export async function applyChoreCleanup(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    datesChanged,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    datesChanged: boolean;
  },
): Promise<string[]> {
  let choreWarnings: string[] = [];
  if (datesChanged) {
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
    );
    choreWarnings = result.choreWarnings;
  }
  const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
    tx,
    bookingId,
  );
  return [...choreWarnings, ...rangeCleanup.choreWarnings];
}
