import {
  BookingStatus,
  PaymentStatus,
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Member,
  type Payment,
  type Prisma,
  type PromoCode,
  type PromoRedemption,
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
  getBookingEditPolicy,
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  calculatePromoDiscountForGuestRates,
  getMemberFreeNightsUsed,
  redeemPromoCode,
  validatePromoCodeRules,
} from "@/lib/promo";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import {
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";

export type BatchModifyInput = {
  checkIn?: string;
  checkOut?: string;
  addGuests?: Array<{
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId?: string;
  }>;
  removeGuestIds?: string[];
  promoCode?: string;
  removePromoCode?: boolean;
};

export type LoadedPromoRedemption = PromoRedemption & {
  promoCode: PromoCode & {
    assignments: Array<{ memberId: string }>;
  };
};

export type LoadedBookingForModify = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
  member: Member;
  promoRedemption: LoadedPromoRedemption | null;
};

export type ResolvedTargetDates = {
  newCheckIn: Date;
  newCheckOut: Date;
  isInProgressEdit: boolean;
  editableFrom: Date | null;
  skipBookingLifecycleRules: boolean;
  checkInChanged: boolean;
  datesChanged: boolean;
};

export function resolveTargetDates({
  booking,
  role,
  input,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  input: BatchModifyInput;
}): ResolvedTargetDates {
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  if (!editPolicy.canModify) {
    throw new ApiError(
      editPolicy.reason ?? "This booking cannot be modified",
      400,
    );
  }

  const requestedCheckIn = input.checkIn
    ? parseDateOnly(input.checkIn)
    : booking.checkIn;
  const requestedCheckOut = input.checkOut
    ? parseDateOnly(input.checkOut)
    : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    throw new ApiError("Invalid booking dates", 400);
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const editableFrom = editPolicy.editableFrom;
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);

  if (isInProgressEdit) {
    if (
      input.checkIn &&
      formatDateOnly(normalizeDateOnlyForTimeZone(requestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      throw new ApiError(
        "Check-in cannot be changed for an in-progress booking",
        400,
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(requestedCheckOut) < editableFrom) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }
    if (input.promoCode || input.removePromoCode) {
      throw new ApiError(
        "Promo code changes are not available for in-progress bookings",
        400,
      );
    }
  } else if (
    role !== "ADMIN" &&
    normalizeDateOnlyForTimeZone(requestedCheckIn) <= editPolicy.today
  ) {
    throw new ApiError(
      "NZ today and earlier are locked for self-service changes",
      400,
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : requestedCheckIn;
  const newCheckOut = requestedCheckOut;

  if (newCheckOut <= newCheckIn) {
    throw new ApiError("Check-out must be after check-in", 400);
  }

  const skipBookingLifecycleRules =
    role === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status);

  const checkInChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime();
  const datesChanged =
    checkInChanged ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  return {
    newCheckIn,
    newCheckOut,
    isInProgressEdit,
    editableFrom,
    skipBookingLifecycleRules,
    checkInChanged,
    datesChanged,
  };
}

export type GuestPlan = {
  remainingGuests: BookingGuest[];
  removedGuests: BookingGuest[];
  normalizedAddGuests: BookingGuestInput[] | undefined;
  guestsForPricing: Array<{
    ageTier: AgeTier;
    isMember: boolean;
    memberId: string | null;
  }>;
  totalGuestCount: number;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
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
  }: {
    booking: LoadedBookingForModify;
    role: Role;
    actorId: string;
    input: BatchModifyInput;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
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
    ? normalizeBookingGuestInputs(input.addGuests, linkedMembers)
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

  const guestsForPricing = [
    ...remainingGuests.map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
    })),
    ...(normalizedAddGuests ?? []).map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
    })),
  ];

  const totalGuestCount = guestsForPricing.length;
  if (totalGuestCount > LODGE_CAPACITY) {
    throw new ApiError(
      `A booking cannot exceed ${LODGE_CAPACITY} guests`,
      400,
    );
  }

  const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

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
    removedGuests,
    normalizedAddGuests,
    guestsForPricing,
    totalGuestCount,
    requiresAdminReview,
    adminReviewReason,
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
    guests: Array<{ priceCents: number; perNightCents: number[] }>;
  };
  guestNightRates: Array<{
    memberId: string | null;
    perNightRates: number[];
  }>;
};

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
    totalGuestCount,
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
      ageTier: AgeTier;
      isMember: boolean;
      memberId: string | null;
    }>;
    totalGuestCount: number;
    skipBookingLifecycleRules: boolean;
    seasonRateData: SeasonRateData[];
  },
): Promise<PricingResult> {
  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  if (isInProgressEdit && editableFrom) {
    inProgressPlan = buildInProgressGuestRangePlan({
      booking: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        finalPriceCents: booking.finalPriceCents,
        guests: booking.guests.map((guest) => ({
          ...guest,
          ageTier: guest.ageTier as AgeTier,
        })),
      },
      editableFrom,
      newCheckOut,
      addGuests: normalizedAddGuests,
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
      : await checkCapacity(newCheckIn, newCheckOut, totalGuestCount, bookingId, tx);
  if (!capacity.available) {
    throw new ApiError("Not enough beds available for these changes", 400);
  }

  let priceBreakdown: PricingResult["priceBreakdown"];
  try {
    priceBreakdown = inProgressPlan
      ? {
          totalPriceCents: inProgressPlan.newTotalPriceCents,
          guests: [
            ...inProgressPlan.proposedExistingGuests.map((entry) => ({
              priceCents: entry.priceCents,
              perNightCents: [] as number[],
            })),
            ...inProgressPlan.proposedAddedGuests.map((entry) => ({
              priceCents: entry.priceCents,
              perNightCents: [] as number[],
            })),
          ],
        }
      : calculateBookingPrice(newCheckIn, newCheckOut, guestsForPricing, seasonRateData);
  } catch {
    throw new ApiError("No season rate found for the requested dates", 400);
  }

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const guestNightRates = inProgressPlan
    ? []
    : guestsForPricing.map((guest) => {
        const breakdown = calculateBookingPrice(
          newCheckIn,
          newCheckOut,
          [guest],
          seasonRateData,
        );
        return {
          memberId: guest.memberId ?? null,
          perNightRates: breakdown.guests[0].perNightCents,
        };
      });

  return {
    inProgressPlan,
    newTotalPriceCents,
    priceBreakdown,
    guestNightRates,
  };
}

export type PromoChangeResult = {
  newDiscountCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
};

export async function applyPromoCodeChanges(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    input,
    inProgressPlan,
    newTotalPriceCents,
    guestNightRates,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    input: BatchModifyInput;
    inProgressPlan: BookingEditGuestRangePlan | null;
    newTotalPriceCents: number;
    guestNightRates: Array<{
      memberId: string | null;
      perNightRates: number[];
    }>;
  },
): Promise<PromoChangeResult> {
  if (inProgressPlan) {
    return {
      newDiscountCents: inProgressPlan.newDiscountCents,
      promoRemoved: false,
      promoChanged: false,
    };
  }

  let newDiscountCents = 0;
  let promoRemoved = false;
  let promoChanged = false;

  if (input.removePromoCode && booking.promoRedemption) {
    await tx.promoRedemption.delete({
      where: { id: booking.promoRedemption.id },
    });
    await tx.promoCode.update({
      where: { id: booking.promoRedemption.promoCodeId },
      data: { currentRedemptions: { decrement: 1 } },
    });
    promoRemoved = true;
  }

  if (input.promoCode && !input.removePromoCode) {
    if (booking.promoRedemption && !promoRemoved) {
      await tx.promoRedemption.delete({
        where: { id: booking.promoRedemption.id },
      });
      await tx.promoCode.update({
        where: { id: booking.promoRedemption.promoCodeId },
        data: { currentRedemptions: { decrement: 1 } },
      });
      promoRemoved = true;
    }

    const promoCode = await tx.promoCode.findUnique({
      where: { code: input.promoCode.toUpperCase().trim() },
      include: { assignments: { select: { memberId: true } } },
    });

    if (!promoCode) throw new ApiError("Promo code not found", 400);

    let memberRedemptionCount = 0;
    if (promoCode.singleUse) {
      memberRedemptionCount = await tx.promoRedemption.count({
        where: {
          promoCodeId: promoCode.id,
          memberId: booking.memberId,
          bookingId: { not: bookingId },
        },
      });
    }

    let memberFreeNightsUsed = 0;
    if (promoCode.type === "FREE_NIGHTS" && promoCode.freeNights) {
      memberFreeNightsUsed = await getMemberFreeNightsUsed(
        promoCode.id,
        booking.memberId,
        bookingId,
      );
    }

    const assignedMemberIds = promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null;
    const validationError = validatePromoCodeRules(
      promoCode,
      { memberId: booking.memberId },
      new Date(),
      memberRedemptionCount,
      assignedMemberIds,
      memberFreeNightsUsed,
    );
    if (validationError) throw new ApiError(validationError, 400);

    const remainingFreeNights =
      promoCode.type === "FREE_NIGHTS" && promoCode.freeNights
        ? promoCode.freeNights - memberFreeNightsUsed
        : undefined;
    const promoResult = calculatePromoDiscountForGuestRates(
      {
        type: promoCode.type,
        valueCents: promoCode.valueCents,
        percentOff: promoCode.percentOff,
        freeNights: promoCode.freeNights,
      },
      newTotalPriceCents,
      booking.memberId,
      guestNightRates,
      assignedMemberIds,
      undefined,
      remainingFreeNights,
    );
    newDiscountCents = promoResult.discountCents;

    await redeemPromoCode(
      tx,
      promoCode.id,
      bookingId,
      booking.memberId,
      newDiscountCents,
      promoResult.freeNightsUsed,
    );
    promoChanged = true;
  } else if (
    !input.removePromoCode &&
    !promoRemoved &&
    booking.promoRedemption?.promoCode
  ) {
    const promo = booking.promoRedemption.promoCode;
    const memberFreeNightsUsed =
      promo.type === "FREE_NIGHTS" && promo.freeNights
        ? await getMemberFreeNightsUsed(promo.id, booking.memberId, bookingId)
        : 0;
    const validationError = validatePromoCodeRules(
      promo,
      { memberId: booking.memberId },
      new Date(),
      0,
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      memberFreeNightsUsed,
    );

    if (validationError) {
      await tx.promoRedemption.delete({
        where: { id: booking.promoRedemption.id },
      });
      await tx.promoCode.update({
        where: { id: promo.id },
        data: { currentRedemptions: { decrement: 1 } },
      });
      promoRemoved = true;
    } else {
      const remainingFreeNights =
        promo.type === "FREE_NIGHTS" && promo.freeNights
          ? promo.freeNights - memberFreeNightsUsed
          : undefined;
      const promoResult = calculatePromoDiscountForGuestRates(
        {
          type: promo.type,
          valueCents: promo.valueCents,
          percentOff: promo.percentOff,
          freeNights: promo.freeNights,
        },
        newTotalPriceCents,
        booking.memberId,
        guestNightRates,
        promo.assignments.length > 0
          ? promo.assignments.map((assignment) => assignment.memberId)
          : null,
        undefined,
        remainingFreeNights,
      );
      newDiscountCents = promoResult.discountCents;

      await tx.promoRedemption.update({
        where: { id: booking.promoRedemption.id },
        data: {
          discountCents: newDiscountCents,
          freeNightsUsed: promoResult.freeNightsUsed || null,
        },
      });
    }
  }

  return { newDiscountCents, promoRemoved, promoChanged };
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
    normalizedAddGuests,
    priceBreakdown,
    inProgressPlan,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    removedGuests: BookingGuest[];
    remainingGuests: BookingGuest[];
    normalizedAddGuests: BookingGuestInput[] | undefined;
    priceBreakdown: PricingResult["priceBreakdown"];
    inProgressPlan: BookingEditGuestRangePlan | null;
  },
): Promise<{ createdGuests: BookingGuest[] }> {
  const createdGuests: BookingGuest[] = [];

  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedExistingGuests) {
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: {
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
        },
      });
    }

    for (const entry of inProgressPlan.proposedAddedGuests) {
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
      createdGuests.push(guest);
    }

    return { createdGuests };
  }

  for (const guest of removedGuests) {
    await tx.choreAssignment.deleteMany({
      where: { bookingGuestId: guest.id },
    });
    await tx.bookingGuest.delete({ where: { id: guest.id } });
  }

  const addedGuestStartIndex = remainingGuests.length;
  const addList = normalizedAddGuests ?? [];
  for (let i = 0; i < addList.length; i++) {
    const g = addList[i];
    const guestPriceIndex = addedGuestStartIndex + i;
    const guest = await tx.bookingGuest.create({
      data: {
        bookingId,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId || null,
        stayStart: newCheckIn,
        stayEnd: newCheckOut,
        priceCents: priceBreakdown.guests[guestPriceIndex].priceCents,
      },
    });
    createdGuests.push(guest);
  }

  for (let i = 0; i < remainingGuests.length; i++) {
    await tx.bookingGuest.update({
      where: { id: remainingGuests[i].id },
      data: {
        stayStart: newCheckIn,
        stayEnd: newCheckOut,
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

export type PaymentAdjustmentResult = {
  refundAmountCents: number;
  additionalAmountCents: number;
  pendingRefundAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
};

const SETTLED_BOOKING_STATUSES = [
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

export async function applyPaymentAdjustments(
  tx: Prisma.TransactionClient,
  {
    booking,
    priceDiffCents,
    changeFeeCents,
  }: {
    booking: LoadedBookingForModify;
    priceDiffCents: number;
    changeFeeCents: number;
  },
): Promise<PaymentAdjustmentResult> {
  const inSettledStatus = (SETTLED_BOOKING_STATUSES as readonly string[]).includes(
    booking.status,
  );
  const hasSucceededPayment =
    inSettledStatus && booking.payment?.status === "SUCCEEDED";
  const hasIssuedXeroInvoice =
    inSettledStatus && !!booking.payment?.xeroInvoiceId;

  const xeroNetAmountCents = hasIssuedXeroInvoice
    ? priceDiffCents + changeFeeCents
    : 0;
  const xeroRefundAmountCents =
    xeroNetAmountCents < 0 ? Math.abs(xeroNetAmountCents) : 0;
  const xeroAdditionalAmountCents =
    xeroNetAmountCents > 0 ? xeroNetAmountCents : 0;

  let refundAmountCents = 0;
  let additionalAmountCents = 0;
  let pendingRefundAmountCents = 0;

  if (hasSucceededPayment && booking.payment) {
    if (priceDiffCents < 0) {
      refundAmountCents = Math.abs(priceDiffCents);
      pendingRefundAmountCents = refundAmountCents;
    } else if (priceDiffCents > 0 || changeFeeCents > 0) {
      additionalAmountCents = Math.max(priceDiffCents, 0) + changeFeeCents;
    }

    if (changeFeeCents > 0) {
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { changeFeeCents: { increment: changeFeeCents } },
      });
    }
  } else if (xeroAdditionalAmountCents > 0) {
    additionalAmountCents = xeroAdditionalAmountCents;
  }

  return {
    refundAmountCents,
    additionalAmountCents,
    pendingRefundAmountCents,
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    xeroRefundAmountCents,
    xeroAdditionalAmountCents,
  };
}

export type LifecycleTransitionResult = {
  hasNonMembers: boolean;
  newNonMemberHoldUntil: Date | null;
  newStatus: BookingStatus;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
};

export async function applyLifecycleTransitions(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    newCheckIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    newCheckIn: Date;
    newFinalPriceCents: number;
    guestsForPricing: Array<{ isMember: boolean }>;
    skipBookingLifecycleRules: boolean;
  },
): Promise<LifecycleTransitionResult> {
  const hasNonMembers = !guestsForPricing.every((g) => g.isMember);
  let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
  let newStatus = booking.status;
  let zeroDollarAutoPaid = false;
  let supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] = [];

  if (!skipBookingLifecycleRules && hasNonMembers) {
    const holdDays = await getNonMemberHoldDays(newCheckIn);
    const daysUntilNewCheckIn = Math.ceil(
      (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilNewCheckIn <= holdDays) {
      newNonMemberHoldUntil = null;
      if (booking.status === "PENDING") {
        newStatus = "PAYMENT_PENDING";
      }
    } else {
      newNonMemberHoldUntil = new Date(
        newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000,
      );
    }
  } else if (!skipBookingLifecycleRules) {
    newNonMemberHoldUntil = null;
  }

  if (
    !skipBookingLifecycleRules &&
    newFinalPriceCents === 0 &&
    newStatus === BookingStatus.PAYMENT_PENDING
  ) {
    newStatus = BookingStatus.PAID;
    zeroDollarAutoPaid = true;
    const zeroDollarPayment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
      update: {
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: zeroDollarPayment.id,
        newFinalPriceCents,
      });
  }

  return {
    hasNonMembers,
    newNonMemberHoldUntil,
    newStatus,
    zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents,
  };
}

export function assertBookingModifiable(
  booking: LoadedBookingForModify | null,
  { role, actorId }: { role: Role; actorId: string },
): asserts booking is LoadedBookingForModify {
  if (!booking) throw new ApiError("Booking not found", 404);
  if (booking.memberId !== actorId && role !== "ADMIN") {
    throw new ApiError("Forbidden", 403);
  }
  if (!canModifyBookingStatusForRole(booking.status, role)) {
    throw new ApiError(
      "This booking cannot be modified in its current status",
      400,
    );
  }
}
