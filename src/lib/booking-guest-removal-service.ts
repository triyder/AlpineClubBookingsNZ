import { BookingStatus, type AgeTier, type Prisma } from "@prisma/client";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import type { SupersededPrimaryPaymentIntent } from "@/lib/booking-payment-cleanup";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getSeasonYear } from "@/lib/utils";
import {
  getTodayDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";

export class BookingGuestRemovalError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export type RemoveBookingGuestResult = {
  booking: Prisma.BookingGetPayload<{ include: { guests: true; payment: true } }>;
  removedGuest: Prisma.BookingGuestGetPayload<Record<string, never>>;
  priceDiffCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  pendingRefundAmountCents: number;
  additionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  paymentStatus: string | null;
  paymentId: string | null;
  paymentCustomerId: string | null;
  memberEmail: string;
  memberName: string;
  memberId: string;
  promoRemoved: boolean;
  choreWarnings: string[];
  oldGuestCount: number;
  bookingModificationId: string;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
};

const SELF_REMOVABLE_GUEST_BOOKING_STATUSES = new Set<string>([
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
]);

type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
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

export async function removeBookingGuestInTransaction({
  tx,
  bookingId,
  guestId,
  actorMemberId,
  actorRole,
  settlementMethod,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  actorRole: string;
  settlementMethod?: BookingModificationSettlementMethod;
}): Promise<RemoveBookingGuestResult> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: {
        include: {
          nights: { select: { stayDate: true, priceCents: true } },
        },
      },
      payment: true,
      member: true,
        promoRedemption: {
          include: {
            guestTargets: { select: { bookingGuestId: true } },
            promoCode: {
              include: { assignments: { select: { memberId: true } } },
            },
          },
        },
    },
  });

  if (!booking) {
    throw new BookingGuestRemovalError("Booking not found", 404);
  }

  const guestToRemove = booking.guests.find((guest) => guest.id === guestId);
  const isOwnerOrAdmin = booking.memberId === actorMemberId || actorRole === "ADMIN";
  const isSelfRemoval =
    !isOwnerOrAdmin && guestToRemove?.memberId === actorMemberId;
  const isLinkedGuestViewer = booking.guests.some(
    (guest) => guest.memberId === actorMemberId,
  );

  if (!isOwnerOrAdmin && !isLinkedGuestViewer) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  if (!guestToRemove) {
    throw new BookingGuestRemovalError(
      isOwnerOrAdmin ? "Guest not found on this booking" : "Forbidden",
      isOwnerOrAdmin ? 404 : 403,
    );
  }

  if (!isOwnerOrAdmin && !isSelfRemoval) {
    throw new BookingGuestRemovalError("Forbidden", 403);
  }

  if (
    !isSelfRemoval &&
    !["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      400
    );
  }
  if (
    isSelfRemoval &&
    !SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(booking.status)
  ) {
    throw new BookingGuestRemovalError(
      "You cannot remove yourself from this booking in its current status",
      400,
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  const selfRemovalIsFuture =
    isSelfRemoval &&
    normalizeDateOnlyForTimeZone(booking.checkIn) > getTodayDateOnly();
  if (!isSelfRemoval && !editPolicy.canModify) {
    throw new BookingGuestRemovalError(
      editPolicy.reason ?? "This booking cannot be modified",
      400
    );
  }
  if (isSelfRemoval && !selfRemovalIsFuture) {
    throw new BookingGuestRemovalError(
      "Only future booking guests can remove themselves from another member's booking",
      400,
    );
  }
  if (!isSelfRemoval && editPolicy.mode !== "future") {
    throw new BookingGuestRemovalError(
      "Use the full booking edit flow for in-progress booking guest changes",
      400
    );
  }

  if (booking.guests.length <= 1) {
    throw new BookingGuestRemovalError(
      "Cannot remove the last guest. Cancel the booking instead.",
      400
    );
  }

  await assertBookingNotQuotePriced(tx, bookingId);

  const choreWarnings = await removeGuestChoreAssignments(tx, guestId);

  await tx.bookingGuest.delete({ where: { id: guestId } });

  const remainingGuests = booking.guests.filter((guest) => guest.id !== guestId);
  const seasonRateData = await loadSeasonRateData(tx);

  const guestsForPricing = remainingGuests.map((guest) => ({
    bookingGuestId: guest.id,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    // Remaining guests keep their booked nightly prices (#1036): removing a
    // guest must return exactly that guest's own price, policy permitting.
    lockedNightPrices: lockedNightPricesForGuest(guest),
  }));
  const seasonYear = getSeasonYear(booking.checkIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
  });

  const priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
    ownerMemberId: booking.memberId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: guestsForPricing,
    seasons: seasonRateData,
    seasonYear,
  });
  const guestNightRates = guestsForPricing.map((guest, index) => ({
    bookingGuestId: guest.bookingGuestId,
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: priceBreakdown.guests[index].perNightCents,
    nightDates: priceBreakdown.guests[index].nightDates,
    // Guests are priced over the full booking range here, so the first
    // rate is the check-in night. Dates the rates so internal work-party
    // promos restrict the discount to the event's night window.
    firstNight: booking.checkIn,
  }));

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const promoResult = await recalculateBookingPromo({
    tx,
    bookingId,
    booking,
    newTotalPriceCents,
    guestNightRates,
  });
  const newFinalPriceCents = newTotalPriceCents + promoResult.newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  const requiresAdminReview = requiresAdultSupervisionReview(remainingGuests);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

  // Settle the reduction through the same policy-based machinery the batch
  // modify path uses (#1014): a captured payment is refunded/credited only up
  // to the cancellation-policy tier for the days until check-in, and the
  // member must choose card vs credit. Previously this path refunded the full
  // guest cost with no policy tier, bypassing the cancellation window that the
  // batch endpoint enforces for the identical economic change.
  const settlementOptions = await calculateModificationSettlementOptions({
    booking: booking as unknown as LoadedBookingForModify,
    netChargeCents: priceDiffCents,
  });
  if (settlementOptions?.requiresSettlementMethod && !settlementMethod) {
    // A settled booking needs an explicit card/credit election. The only
    // body-less caller is a linked guest self-removing to resolve a night
    // conflict; for an already-paid target the owner's funds must not be
    // settled without their choice, so block and defer to the owner/admin
    // (who edit through the batch flow's chooser).
    throw new BookingGuestRemovalError(
      "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
      400,
    );
  }
  const paymentImpact = await applyPaymentAdjustments(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    priceDiffCents,
    changeFeeCents: 0,
    settlementOptions,
    settlementMethod,
  });

  // Run the same lifecycle transitions the batch path applies (#1041):
  // non-member-hold recalculation (an all-member booking clears its hold),
  // PENDING -> PAYMENT_PENDING inside the hold window, and zero-dollar
  // auto-pay with superseded-PaymentIntent cancellation. `reviewUpdate` is
  // deliberately not passed: the removal path keeps its lightweight
  // requiresAdminReview flagging so linked-guest self-removal (which cannot
  // supply a review justification) keeps working.
  const lifecycle = await applyLifecycleTransitions(tx, {
    booking: booking as unknown as LoadedBookingForModify,
    bookingId,
    newCheckIn: booking.checkIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules:
      actorRole === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status),
  });

  await Promise.all(
    remainingGuests.map((guest, index) =>
      tx.bookingGuest.update({
        where: { id: guest.id },
        data: { priceCents: priceBreakdown.guests[index].priceCents },
      })
    )
  );

  const updatedBooking = await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalPriceCents: newTotalPriceCents,
      discountCents: promoResult.newDiscountCents,
      promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
      finalPriceCents: newFinalPriceCents,
      hasNonMembers: lifecycle.hasNonMembers,
      nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
      status: lifecycle.newStatus,
      requiresAdminReview,
      adminReviewReason,
    },
    include: { guests: true, payment: true },
  });

  await reconcileBedAllocationsForBooking({
    bookingId,
    db: tx,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });

  const bookingModification = await tx.bookingModification.create({
    data: {
      bookingId,
      memberId: actorMemberId,
      modificationType: "GUEST_REMOVE",
      previousData: {
        guestCount: booking.guests.length,
        removedGuest: {
          firstName: guestToRemove.firstName,
          lastName: guestToRemove.lastName,
          ageTier: guestToRemove.ageTier,
          isMember: guestToRemove.isMember,
        },
        totalPriceCents: booking.totalPriceCents,
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        finalPriceCents: booking.finalPriceCents,
      },
      newData: {
        guestCount: updatedBooking.guests.length,
        totalPriceCents: newTotalPriceCents,
        discountCents: promoResult.newDiscountCents,
        promoAdjustmentCents: promoResult.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        settlementMethod: paymentImpact.settlementMethod,
        accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
        policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
      },
      priceDiffCents,
      changeFeeCents: 0,
    },
  });

  if (paymentImpact.accountCreditAmountCents > 0) {
    await createBookingModificationCredit(
      booking.memberId,
      paymentImpact.accountCreditAmountCents,
      bookingId,
      bookingModification.id,
      undefined,
      tx,
      booking.payment?.id,
    );
  }

  return {
    booking: updatedBooking,
    removedGuest: guestToRemove,
    priceDiffCents,
    refundAmountCents: paymentImpact.refundAmountCents,
    accountCreditAmountCents: paymentImpact.accountCreditAmountCents,
    pendingRefundAmountCents: paymentImpact.pendingRefundAmountCents,
    additionalAmountCents: paymentImpact.additionalAmountCents,
    settlementMethod: paymentImpact.settlementMethod,
    policyRetainedAmountCents: paymentImpact.policyRetainedAmountCents,
    xeroRefundAmountCents: paymentImpact.xeroRefundAmountCents,
    xeroAdditionalAmountCents: paymentImpact.xeroAdditionalAmountCents,
    hasSucceededPayment: paymentImpact.hasSucceededPayment,
    hasIssuedXeroInvoice: paymentImpact.hasIssuedXeroInvoice,
    paymentStatus: booking.payment?.status ?? null,
    paymentId: booking.payment?.id ?? null,
    paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
    memberEmail: booking.member.email,
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.memberId,
    promoRemoved: promoResult.promoRemoved,
    choreWarnings,
    oldGuestCount: booking.guests.length,
    bookingModificationId: bookingModification.id,
    zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
  };
}

export async function loadSeasonRateData(tx: Prisma.TransactionClient): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true },
    include: { rates: true },
  });

  return seasons.map((season) => ({
    seasonId: season.id,
    startDate: season.startDate,
    endDate: season.endDate,
    rates: season.rates.map((rate) => ({
      ageTier: rate.ageTier,
      isMember: rate.isMember,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  }));
}

async function removeGuestChoreAssignments(
  tx: Prisma.TransactionClient,
  guestId: string
) {
  const choreWarnings: string[] = [];
  const guestAssignments = await tx.choreAssignment.findMany({
    where: { bookingGuestId: guestId },
    include: { choreTemplate: true },
  });

  for (const assignment of guestAssignments) {
    if (
      assignment.status === "CONFIRMED" ||
      assignment.status === "COMPLETED"
    ) {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} was ${assignment.status}`
      );
    }
  }

  await tx.choreAssignment.deleteMany({
    where: { bookingGuestId: guestId },
  });

  return choreWarnings;
}

export async function recalculateBookingPromo({
  tx,
  bookingId,
  booking,
  newTotalPriceCents,
  guestNightRates,
}: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  booking: Prisma.BookingGetPayload<{
    include: {
          promoRedemption: {
            include: {
              guestTargets: { select: { bookingGuestId: true } };
              promoCode: {
                include: { assignments: { select: { memberId: true } } };
              };
            };
          };
    };
  }>;
  newTotalPriceCents: number;
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    firstNight?: Date | null;
  }>;
}) {
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;

  if (booking.promoRedemption?.promoCode) {
    const promo = booking.promoRedemption.promoCode;
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: booking.checkIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      { excludeBookingId: bookingId, db: tx, selectedGuestIndexes },
    );

    if (application.error || !application.discount) {
      promoRemoved = true;
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    } else {
      const discount = application.discount;
      newDiscountCents = discount.discountCents;
      newPromoAdjustmentCents = discount.priceAdjustmentCents;

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        discount.freeNightsUsed,
        discount.eligibleGuestCount,
        discount.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved };
}
