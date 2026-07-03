/**
 * Promo/pricing resolution helpers for the booking-creation service.
 *
 * Extracted verbatim from `booking-create.ts`. Depends only on the shared
 * `booking-create-types` module, never on the orchestrator, to avoid an import
 * cycle.
 */
import { PromoCodeType, type FixedNightlyMode, type BookingGuest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import { resolveWorkPartyEventPromoForBooking } from "@/lib/work-party";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { type BookingGuestInput, BookingPromoError } from "./booking-create-types";

export interface ResolvedPromo {
  discountCents: number;
  promoAdjustmentCents: number;
  promoFreeNightsUsed: number;
  promoEligibleGuestCount: number;
  promoAllocations: PromoBeneficiaryAllocation[];
  promoSelectedGuestIndexes?: number[];
  promoShouldPersist: boolean;
  promoCodeRecord:
    | {
        id: string;
        type: PromoCodeType;
        valueCents: number | null;
        percentOff: number | null;
        freeNightsPerIndividual: number | null;
        lifetimeFreeNightsCap: number | null;
        fixedNightlyPriceCents: number | null;
        fixedNightlyMode: FixedNightlyMode | null;
        maxGuestsPerBooking: number | null;
        maxNightlyValueCents: number | null;
        memberGuestsOnly: boolean;
        assignedMembersOnlyOwnNights?: boolean | null;
      }
    | null;
}

export type LockedPromoRow = {
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom: Date | null;
  bookingStartUntil: Date | null;
  maxRedemptionsTotal: number | null;
  maxUniqueMembersTotal: number | null;
  maxUsesPerMember: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  memberGuestsOnly: boolean;
  type: PromoCodeType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  code: string;
  assignedMembersOnlyOwnNights: boolean;
  internal: boolean;
};

export function getPromoTargetBookingGuestIds(
  bookingGuests: BookingGuest[],
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => bookingGuests[index]?.id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Resolve and validate a promo code inside the booking transaction.
 * Locks the row for update so concurrent bookings cannot over-redeem.
 * Throws BookingPromoError on validation failure so the caller can
 * roll back and return a 400.
 *
 * Internal promos (work party events) are rejected like unknown codes
 * unless allowInternal is set by the work-party resolution path.
 */
export async function resolvePromoInTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  options: {
    promoCodeStr: string;
    effectiveMemberId: string;
    checkIn: Date;
    guests: BookingGuestInput[];
    totalPriceCents: number;
    perNightCentsByGuest: number[][];
    nightDatesByGuest?: Date[][];
    promoGuestIndexes?: number[];
    allowInternal?: boolean;
  },
): Promise<ResolvedPromo> {
  const {
    promoCodeStr,
    effectiveMemberId,
    checkIn,
    guests,
    totalPriceCents,
    perNightCentsByGuest,
    nightDatesByGuest,
    promoGuestIndexes,
    allowInternal,
  } = options;
  const normalizedCode = promoCodeStr.toUpperCase().trim();
  const lockedRows = await tx.$queryRaw<LockedPromoRow[]>`
    SELECT * FROM "PromoCode" WHERE "code" = ${normalizedCode} FOR UPDATE
  `;
  const promoCode = lockedRows.length > 0 ? lockedRows[0] : null;

  if (promoCode?.internal && !allowInternal) {
    throw new BookingPromoError("Promo code not found");
  }

  let assignedMemberIds: string[] | null = null;
  if (promoCode) {
    const assignments = await tx.promoCodeAssignment.findMany({
      where: { promoCodeId: promoCode.id },
      select: { memberId: true },
    });
    if (assignments.length > 0) {
      assignedMemberIds = assignments.map((a) => a.memberId);
    }
  }

  const guestNightRates = guests.map((guest, index) => ({
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: perNightCentsByGuest[index],
    firstNight: guest.stayStart ?? checkIn,
    nightDates: nightDatesByGuest?.[index],
  }));
  const application = await validateAndCalculatePromoDiscount(
    promoCode,
    {
      memberId: effectiveMemberId,
      bookingCheckIn: checkIn,
      totalPriceCents,
      guests: guestNightRates,
    },
    assignedMemberIds,
    { db: tx, selectedGuestIndexes: promoGuestIndexes }
  );
  if (application.error || !application.discount) {
    throw new BookingPromoError(application.error ?? "Promo code could not be applied");
  }
  const promoResult = application.discount;

  return {
    discountCents: promoResult.discountCents,
    promoAdjustmentCents: promoResult.priceAdjustmentCents,
    promoFreeNightsUsed: promoResult.freeNightsUsed,
    promoEligibleGuestCount: promoResult.eligibleGuestCount,
    promoAllocations: promoResult.allocations,
    promoSelectedGuestIndexes: application.selectedGuestIndexes,
    promoShouldPersist: shouldPersistPromoRedemption(promoResult),
    promoCodeRecord: promoCode,
  };
}

export const PROMO_WORK_PARTY_EXCLUSION_MESSAGE =
  "A promo code cannot be combined with a working bee discount. Please remove one of them and try again.";

/**
 * Resolve the effective promo source for a booking: either the
 * member-entered code or the selected work party event's internal promo.
 * Only one PromoRedemption can exist per booking, so the two are mutually
 * exclusive. Throws BookingPromoError when both are supplied or the event
 * is not bookable for these dates.
 */
export async function resolveEffectivePromoSource(
  db: Parameters<typeof resolveWorkPartyEventPromoForBooking>[0],
  options: {
    promoCodeStr?: string;
    workPartyEventId?: string;
    checkIn: Date;
    checkOut: Date;
  }
): Promise<{ promoCodeStr: string; allowInternal: boolean } | null> {
  if (!options.workPartyEventId && !options.promoCodeStr) {
    return null;
  }

  // Honour the admin module toggles: when a feature is off, its input is ignored
  // (no discount applied) rather than erroring, so a disabled module can never
  // affect pricing even if an id/code reaches this far.
  const modules = await loadEffectiveModuleFlags();
  const workPartyEventId = modules.workParties
    ? options.workPartyEventId
    : undefined;
  const promoCodeStr = modules.promoCodes ? options.promoCodeStr : undefined;

  if (workPartyEventId && promoCodeStr) {
    throw new BookingPromoError(PROMO_WORK_PARTY_EXCLUSION_MESSAGE);
  }
  if (workPartyEventId) {
    const resolution = await resolveWorkPartyEventPromoForBooking(
      db,
      workPartyEventId,
      options.checkIn,
      options.checkOut
    );
    if (!resolution.ok) {
      throw new BookingPromoError(resolution.error);
    }
    return { promoCodeStr: resolution.promoCodeStr, allowInternal: true };
  }
  if (promoCodeStr) {
    return { promoCodeStr, allowInternal: false };
  }
  return null;
}

/**
 * Remap promo-target guest indexes (which point into the full party guest list)
 * onto a subset of that list. Used when a mixed party is split so the promo,
 * which is applied to the member booking, targets the right member guests.
 * Indexes pointing at guests outside the subset (e.g. non-members) are dropped.
 */
export function remapPromoIndexesToSubset(
  indexes: number[] | undefined,
  allGuests: BookingGuestInput[],
  subset: BookingGuestInput[]
): number[] | undefined {
  if (!indexes) return undefined;
  const subsetIndexByGuest = new Map(subset.map((guest, index) => [guest, index]));
  const remapped = indexes
    .map((index) => allGuests[index])
    .map((guest) => (guest ? subsetIndexByGuest.get(guest) : undefined))
    .filter((index): index is number => index !== undefined);
  return remapped.length > 0 ? remapped : undefined;
}
