import {
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Payment,
  PaymentSource,
  type PaymentStatus,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import {
  queueSupersededPrimaryIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import {
  createModificationAdditionalPaymentIntent,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import {
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { checkCapacity } from "@/lib/capacity";
import {
  daysUntilDate,
  getNonMemberHoldDays,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import { normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import { sendBookingModifiedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { prisma } from "@/lib/prisma";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { processWaitlistForDates } from "@/lib/waitlist";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getSeasonYear } from "@/lib/utils";

export type ModifyBookingDatesInput = {
  checkIn?: string;
  checkOut?: string;
  settlementMethod?: BookingModificationSettlementMethod;
};

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type DateModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    promoRemoved: boolean;
    choreWarnings: string[];
    datesChanged: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    xeroRefundAmountCents: number;
    xeroAdditionalAmountCents: number;
  };

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

export type DateModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  choreWarnings: string[];
};

export async function modifyBookingDates({
  bookingId,
  actor,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  input: ModifyBookingDatesInput;
  ipAddress: string;
}): Promise<DateModificationResponse> {
  const {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    settlementMethod,
  } = input;

  const result = await prisma.$transaction(async (tx) => {
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
      throw new ApiError("Booking not found", 404);
    }

    if (booking.memberId !== actor.id && actor.role !== "ADMIN") {
      throw new ApiError("Forbidden", 403);
    }
    await assertBookingNotQuotePriced(tx, bookingId);

    if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
      throw new ApiError(
        "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
        400,
      );
    }

    const editPolicy = getBookingEditPolicy({
      status: booking.status,
      role: actor.role,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }
    if (editPolicy.mode !== "future") {
      throw new ApiError(
        "Use the full booking edit flow for in-progress booking date changes",
        400,
      );
    }

    const newCheckIn = newCheckInStr
      ? parseDateOnly(newCheckInStr)
      : booking.checkIn;
    const newCheckOut = newCheckOutStr
      ? parseDateOnly(newCheckOutStr)
      : booking.checkOut;

    if (
      Number.isNaN(newCheckIn.getTime()) ||
      Number.isNaN(newCheckOut.getTime())
    ) {
      throw new ApiError("Invalid booking dates", 400);
    }

    if (newCheckOut <= newCheckIn) {
      throw new ApiError("Check-out must be after check-in", 400);
    }

    if (
      actor.role !== "ADMIN" &&
      normalizeDateOnlyForTimeZone(newCheckIn) <= editPolicy.today
    ) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }

    if (actor.role !== "ADMIN") {
      const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
      const stayResult = await validateMinimumStay(newCheckIn, newCheckOut);
      if (!stayResult.valid) {
        throw new ApiError(
          formatViolationsDetail(stayResult.violations),
          400,
        );
      }
    }

    const capacity = await checkCapacity(
      newCheckIn,
      newCheckOut,
      booking.guests.length,
      bookingId,
      tx,
    );

    if (!capacity.available) {
      throw new ApiError(
        "Not enough beds available for the new dates",
        400,
      );
    }

    const seasons = await tx.season.findMany({
      where: { active: true },
      include: { rates: true },
    });

    const seasonRateData: SeasonRateData[] = seasons.map((s) => ({
      seasonId: s.id,
      startDate: s.startDate,
      endDate: s.endDate,
      rates: s.rates.map((r) => ({
        ageTier: r.ageTier,
        isMember: r.isMember,
        pricePerNightCents: r.pricePerNightCents,
      })),
    }));

    const guestsForPricing = booking.guests.map((g) => ({
      bookingGuestId: g.id,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      // Policy (#1093): a booking date change resets every guest — partial
      // stays included — to the full new range, mirroring the batch path's
      // date-change reset. That is why no per-guest night set is passed here.
      // Nights kept across the date change keep their booked price (#1036);
      // only the nights the new range adds price at current season rates.
      lockedNightPrices: lockedNightPricesForGuest(g),
    }));
    const seasonYear = getSeasonYear(newCheckIn);
    await assertMembershipTypeBookingAllowed(tx, {
      ownerMemberId: booking.memberId,
      guests: guestsForPricing,
      seasonYear,
    });

    let priceBreakdown;
    try {
      priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: guestsForPricing,
        seasons: seasonRateData,
        seasonYear,
      });
    } catch (error) {
      if (error instanceof MembershipTypeBookingPolicyError) {
        throw error;
      }
      throw new ApiError(
        "No season rate found for the requested dates",
        400,
      );
    }

    const newTotalPriceCents = priceBreakdown.totalPriceCents;
    const guestNightRates = guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown.guests[index].perNightCents,
      nightDates: priceBreakdown.guests[index].nightDates,
      // Guests are priced over the full new range here, so the first rate
      // is the new check-in night. Dates the rates so internal work-party
      // promos restrict the discount to the event's night window.
      firstNight: newCheckIn,
    }));

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
        promoRemoved = true;
        await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
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

    const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    let changeFeeCents = 0;
    const checkInChanged =
      newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

    if (checkInChanged) {
      const now = new Date();
      const policy = await loadCancellationPolicy(booking.checkIn);
      const feeResult = calculateChangeFee({
        daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
        daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
        originalFinalPriceCents: booking.finalPriceCents,
        policyRules: policy,
      });
      changeFeeCents = feeResult.feeCents;
    }

    // Settle the date change through the same policy-based machinery the batch
    // modify path uses (#1024). netCharge folds the change fee into the price
    // delta, so the cancellation-policy tier is applied to the fee-adjusted
    // reduction and the member must choose card vs credit. Previously this
    // path refunded the full Math.abs(netAmount) with no policy tier, letting a
    // member shorten a booking inside the cancellation window and recover more
    // than cancelling or removing guests for the same nights would return.
    const netChargeCents = priceDiffCents + changeFeeCents;
    const settlementOptions = await calculateModificationSettlementOptions({
      booking: booking as unknown as LoadedBookingForModify,
      netChargeCents,
    });
    if (settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      throw new ApiError(
        "Choose a refund or account credit before saving",
        400,
      );
    }
    const payments = await applyPaymentAdjustments(tx, {
      booking: booking as unknown as LoadedBookingForModify,
      priceDiffCents,
      changeFeeCents,
      settlementOptions,
      settlementMethod,
    });
    const {
      refundAmountCents,
      accountCreditAmountCents,
      additionalAmountCents,
      pendingRefundAmountCents,
      hasSucceededPayment,
      hasIssuedXeroInvoice,
      xeroRefundAmountCents,
      xeroAdditionalAmountCents,
    } = payments;

    const hasNonMembers = booking.guests.some((g) => !g.isMember);
    let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
    let newStatus = booking.status;

    if (hasNonMembers) {
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
    } else {
      newNonMemberHoldUntil = null;
    }

    // Re-sync each guest's BookingGuestNight rows to the priced nights of the
    // new range (#1093). Leaving the old rows in place would hand a later edit
    // a stale night set — it would price the guest over nights the booking no
    // longer covers instead of the range they now hold.
    await Promise.all(
      booking.guests.map(async (g, i) => {
        await tx.bookingGuest.update({
          where: { id: g.id },
          data: {
            stayStart: newCheckIn,
            stayEnd: newCheckOut,
            priceCents: priceBreakdown.guests[i].priceCents,
          },
        });
        await tx.bookingGuestNight.deleteMany({
          where: { bookingGuestId: g.id },
        });
        const nightDates = priceBreakdown.guests[i].nightDates ?? [];
        if (nightDates.length > 0) {
          await tx.bookingGuestNight.createMany({
            data: nightDates.map((stayDate, k) => ({
              bookingGuestId: g.id,
              stayDate,
              priceCents: priceBreakdown.guests[i].perNightCents[k] ?? 0,
            })),
          });
        }
      }),
    );

    const oldCheckIn = new Date(booking.checkIn);
    const oldCheckOut = new Date(booking.checkOut);
    const datesChanged =
      newCheckIn.getTime() !== oldCheckIn.getTime() ||
      newCheckOut.getTime() !== oldCheckOut.getTime();
    const dateCleanup = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
    );
    const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
      tx,
      bookingId,
    );
    const choreWarnings = [
      ...dateCleanup.choreWarnings,
      ...rangeCleanup.choreWarnings,
    ];

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        totalPriceCents: newTotalPriceCents,
        discountCents: newDiscountCents,
        promoAdjustmentCents: newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        nonMemberHoldUntil: newNonMemberHoldUntil,
        status: newStatus,
      },
      include: { guests: true, payment: true },
    });

    await reconcileBedAllocationsForBooking({
      bookingId,
      db: tx,
      previousRange: {
        checkIn: oldCheckIn,
        checkOut: oldCheckOut,
      },
    });

    if (updatedBooking.payment) {
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: updatedBooking.payment.id,
        newFinalPriceCents,
      });
    }

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "DATE_CHANGE",
        previousData: {
          checkIn: oldCheckIn.toISOString().split("T")[0],
          checkOut: oldCheckOut.toISOString().split("T")[0],
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
        },
        newData: {
          checkIn: newCheckIn.toISOString().split("T")[0],
          checkOut: newCheckOut.toISOString().split("T")[0],
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          promoAdjustmentCents: newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          settlementMethod: payments.settlementMethod,
          accountCreditAmountCents: payments.accountCreditAmountCents,
          policyRetainedAmountCents: payments.policyRetainedAmountCents,
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    if (accountCreditAmountCents > 0) {
      await createBookingModificationCredit(
        booking.memberId,
        accountCreditAmountCents,
        bookingId,
        bookingModification.id,
        undefined,
        tx,
        booking.payment?.id,
      );
    }

    // Fire the deferred envelope constraint triggers here so a violation is
    // attributed to this service instead of the transaction's COMMIT.
    await assertBookingEnvelopeInvariants(tx);

    return {
      booking: updatedBooking,
      priceDiffCents,
      changeFeeCents,
      refundAmountCents,
      accountCreditAmountCents,
      settlementMethod: payments.settlementMethod,
      policyRetainedAmountCents: payments.policyRetainedAmountCents,
      additionalAmountCents,
      pendingRefundAmountCents,
      promoRemoved,
      choreWarnings,
      datesChanged,
      oldCheckIn,
      oldCheckOut,
      hasSucceededPayment,
      hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      paymentSource: booking.payment?.source ?? null,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      xeroRefundAmountCents,
      xeroAdditionalAmountCents,
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
    } satisfies DateModificationTransactionResult;
  });

  const stripeRefundId = await executeBookingModificationRefund({
    bookingId,
    result,
    metadataReason: "date_change_price_decrease",
    idempotencyKeyPrefix: `mod_dates_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after date change - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue payment recovery for Stripe refund failure after date change",
  });

  const { additionalPaymentClientSecret, additionalPaymentIntentId } =
    await createModificationAdditionalPaymentIntent({
      bookingId,
      result,
      reason: "date_change_price_increase",
      idempotencyKey: `mod_dates_${bookingId}_${result.bookingModificationId}`,
      failureMessage: "Failed to create additional PaymentIntent for modification",
    });

  await dispatchDatePostTransactionSideEffects({
    bookingId,
    actorMemberId: actor.id,
    ipAddress,
    result,
    additionalPaymentIntentId,
  });

  return {
    booking: result.booking,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    settlementMethod: result.settlementMethod,
    policyRetainedAmountCents: result.policyRetainedAmountCents,
    additionalAmountCents: result.additionalAmountCents,
    additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
    stripeRefundId: stripeRefundId ?? null,
    promoRemoved: result.promoRemoved,
    choreWarnings: result.choreWarnings,
  };
}

async function dispatchDatePostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: DateModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
}): Promise<void> {
  logAudit({
    action: "booking.modify.dates",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Booking dates modified",
    details: JSON.stringify({
      oldCheckIn: result.oldCheckIn.toISOString().split("T")[0],
      oldCheckOut: result.oldCheckOut.toISOString().split("T")[0],
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      promoRemoved: result.promoRemoved,
    }),
    metadata: {
      bookingId,
      oldCheckIn: result.oldCheckIn.toISOString().split("T")[0],
      oldCheckOut: result.oldCheckOut.toISOString().split("T")[0],
      newCheckIn: result.booking.checkIn.toISOString().split("T")[0],
      newCheckOut: result.booking.checkOut.toISOString().split("T")[0],
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      promoRemoved: result.promoRemoved,
    },
    ipAddress,
  });

  void queueXeroBookingEditSettlement({
    bookingId,
    bookingModificationId: result.bookingModificationId,
    createdByMemberId: actorMemberId,
    hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    originalPaymentStatus: result.paymentStatus,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    datesChanged: result.datesChanged,
    // Policy-limited settlement amount + method so a captured-payment reduction
    // issues the correct (card vs credit) modification credit note; an unpaid
    // issued invoice falls back to the full delta inside classify when null.
    settlementAmountCents: result.xeroRefundAmountCents,
    settlementMethod: result.settlementMethod,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error({ err, bookingId }, "Failed to queue Xero settlement for date modification"),
  );

  const member = await prisma.member.findUnique({
    where: { id: result.booking.memberId },
  });
  if (member) {
    sendBookingModifiedEmail({
      email: member.email,
      firstName: member.firstName,
      modificationType: "DATE_CHANGE",
      oldCheckIn: result.oldCheckIn,
      oldCheckOut: result.oldCheckOut,
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      oldGuestCount: result.booking.guests.length,
      newGuestCount: result.booking.guests.length,
      oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
      newFinalPriceCents: result.booking.finalPriceCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      additionalAmountCents: result.additionalAmountCents,
      additionalPaymentMethod:
        result.additionalAmountCents > 0 &&
        result.paymentSource === PaymentSource.INTERNET_BANKING
          ? "INTERNET_BANKING"
          : result.additionalAmountCents > 0 && result.hasSucceededPayment
            ? "STRIPE"
            : undefined,
      paymentReference: result.paymentReference,
      xeroInvoiceNumber: result.xeroInvoiceNumber,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send booking modified email"),
    );
  }

  if (
    result.oldCheckIn.getTime() !== result.booking.checkIn.getTime() ||
    result.oldCheckOut.getTime() !== result.booking.checkOut.getTime()
  ) {
    processWaitlistForDates({
      checkIn: result.oldCheckIn,
      checkOut: result.oldCheckOut,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to process waitlist after date modification"),
    );
  }
}
