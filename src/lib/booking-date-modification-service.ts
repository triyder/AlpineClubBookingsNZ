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
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import {
  createModificationAdditionalPaymentIntent,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import {
  acquireLodgeCapacityLock,
  checkCapacity,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  OverCapacityConfirmationRequiredError,
  overCapacityNights,
} from "@/lib/over-capacity-confirmation";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  applyPaymentAdjustments,
  assertBookingNotQuotePriced,
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { createBookingModificationCredit } from "@/lib/member-credit";
import {
  daysUntilDate,
  getNonMemberHoldPolicy,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
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
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import { processWaitlistForDates } from "@/lib/waitlist";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getSeasonYear } from "@/lib/utils";

export type ModifyBookingDatesInput = {
  checkIn?: string;
  checkOut?: string;
  settlementMethod?: BookingModificationSettlementMethod;
  // Admin-only date override (issue #1668). Only honoured for actor.role ADMIN.
  // adminOverride lifts the date-window locks (in-progress / fully-past);
  // confirmOverCapacity turns an over-capacity target from a throw into a
  // confirmed overbooking. pricingMode "shift" is dispatched at the route to
  // adminShiftBookingDates and never reaches modifyBookingDates; only
  // "recalculate" flows through here.
  adminOverride?: boolean;
  confirmOverCapacity?: boolean;
  // Owner decision (#1668 review): the admin chooses per override edit whether
  // the member receives the change-notification email. Absent = notify.
  notifyMember?: boolean;
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
    adminOverride: boolean;
    notifyMember: boolean;
    capacityOverridden: boolean;
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
    lodges?: Array<{ lodgeId: string }>;
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
  // Admin override (issue #1668): true when an over-capacity target was
  // explicitly confirmed. Always false on the standard (hard-blocked) path.
  capacityOverridden: boolean;
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
    confirmOverCapacity,
  } = input;
  // Issue #1668: only an admin drives the recalculate override on this route.
  const adminOverride = Boolean(input.adminOverride) && actor.role === "ADMIN";
  // Owner decision (#1668 review): under an override the admin chooses whether
  // the member is emailed; absent means notify. Non-override edits always
  // notify (unchanged).
  const notifyMember = !adminOverride || input.notifyMember !== false;

  const result = await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; every capacity- and price-relevant field
    // below is taken from the post-lock re-read.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; all validation, pricing, the
    // capacity check and the claim consume ONLY this post-lock snapshot.
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
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
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

    // Under an admin override the fully-past COMPLETED status is editable too
    // (issue #1668); the standard path keeps the active-lifecycle allowlist.
    const allowedStatuses = adminOverride
      ? ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED"]
      : ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"];
    if (!allowedStatuses.includes(booking.status)) {
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
      adminOverride,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }
    // In-progress/fully-past date changes are still routed through the full edit
    // flow — except under an explicit admin override, whose policy mode is
    // "admin-override" (issue #1668).
    if (editPolicy.mode !== "future" && editPolicy.mode !== "admin-override") {
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

    // Standard path hard-blocks over capacity. Under an admin override
    // (issue #1668) the target nights warn-and-confirm instead: the per-lodge
    // lock is still held (above); over capacity throws OverCapacityConfirmation
    // RequiredError unless confirmOverCapacity was sent. A date change resets
    // every guest to the full new envelope, so the guest-range check (whose
    // availableBeds bakes in the proposed guests) is the correct signal.
    let capacityOverridden = false;
    if (adminOverride) {
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        newCheckIn,
        newCheckOut,
        booking.guests.map(() => ({
          stayStart: newCheckIn,
          stayEnd: newCheckOut,
        })),
        bookingId,
        tx,
      );
      if (!capacity.available) {
        if (!confirmOverCapacity) {
          throw new OverCapacityConfirmationRequiredError(
            overCapacityNights(capacity),
          );
        }
        capacityOverridden = true;
      }
    } else {
      const capacity = await checkCapacity(
        bookingLodgeId,
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
    }

    const seasons = await tx.season.findMany({
      where: { active: true, ...lodgeNullTolerantScope(bookingLodgeId) },
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

    const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
      where: { id: "default" },
    });
    let priceBreakdown;
    try {
      priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: guestsForPricing,
        seasons: seasonRateData,
        // Group discount applies to the nights the new range adds (#1095);
        // nights kept across the date change stay at their locked prices.
        groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
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

    // One-live-booking-per-member-per-night guard (#1157, #1127 F1). A date
    // change resets every guest to the new envelope (see the write loop below),
    // so re-check that no member-linked guest lands on a night where that member
    // is already on another live booking. Mirror the ranges the service is about
    // to persist — stayStart/stayEnd = the new envelope, nights = the priced
    // night set — so the guard evaluates exactly what will exist. This runs
    // under the per-lodge acquireLodgeCapacityLock taken above and before any
    // BookingGuest/BookingGuestNight/Booking writes, so a conflict rolls back
    // with nothing written.
    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: actor.id,
      actorRole: actor.role,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      guests: booking.guests.map((g, index) => ({
        memberId: g.memberId ?? null,
        stayStart: newCheckIn,
        stayEnd: newCheckOut,
        nights: priceBreakdown.guests[index].nightDates ?? [],
      })),
      excludeBookingId: bookingId,
    });

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
        { excludeBookingId: bookingId, db: tx, selectedGuestIndexes, lodgeId: bookingLodgeId },
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
      const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId);
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
      const holdPolicy = await getNonMemberHoldPolicy(
        newCheckIn,
        booking.lodgeId,
      );
      const holdDecision = calculateBookingHoldDecision({
        hasNonMembers,
        checkIn: newCheckIn,
        holdDays: holdPolicy.holdDays,
        holdEnabled: holdPolicy.enabled,
      });

      if (holdDecision.shouldBePending) {
        newNonMemberHoldUntil = new Date(
          newCheckIn.getTime() - holdPolicy.holdDays * 24 * 60 * 60 * 1000,
        );
      } else {
        newNonMemberHoldUntil = null;
        if (booking.status === "PENDING") {
          newStatus = "PAYMENT_PENDING";
        }
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
          ...(adminOverride
            ? { pricingMode: "recalculate", capacityOverridden }
            : {}),
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
      adminOverride,
      notifyMember,
      capacityOverridden,
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

  // Issue #1668: under an admin override, close the approve → apply trail by
  // linking this modification to the booking's most recent approved-unlinked
  // change request. Best-effort; never fails the completed edit.
  const linkedChangeRequestId = result.adminOverride
    ? await linkModificationToOutstandingChangeRequest(
        prisma,
        bookingId,
        result.bookingModificationId,
      )
    : null;

  await dispatchDatePostTransactionSideEffects({
    bookingId,
    actorMemberId: actor.id,
    ipAddress,
    result,
    additionalPaymentIntentId,
    linkedChangeRequestId,
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
    capacityOverridden: result.capacityOverridden,
  };
}

async function dispatchDatePostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
  linkedChangeRequestId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: DateModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
  linkedChangeRequestId: string | null;
}): Promise<void> {
  // Issue #1668: an admin override records the pricing mode, capacity decision
  // and linked change request alongside the standard date-change audit fields.
  const overrideAuditFields = result.adminOverride
    ? {
        adminOverride: true,
        pricingMode: "recalculate",
        confirmOverCapacity: result.capacityOverridden,
        notifyMember: result.notifyMember,
        capacityOverridden: result.capacityOverridden,
        linkedChangeRequestId,
      }
    : {};
  logAudit({
    action: result.adminOverride
      ? "booking.modify.admin_override"
      : "booking.modify.dates",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: result.adminOverride
      ? "Admin override: booking dates recalculated"
      : "Booking dates modified",
    details: JSON.stringify({
      ...overrideAuditFields,
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
      ...overrideAuditFields,
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

  // Owner decision (#1668 review): an override admin may choose not to email
  // the member; the choice is recorded in the audit fields above.
  const member = result.notifyMember
    ? await prisma.member.findUnique({
        where: { id: result.booking.memberId },
      })
    : null;
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
      lodgeId: result.booking.lodgeId,
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
      lodgeId: result.booking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to process waitlist after date modification"),
    );
  }
}

const SHIFT_LENGTH_MISMATCH_MESSAGE =
  'Shift dates only moves the stay without changing its length — use "Recalculate price" to change the number of nights';

/**
 * Admin override "shift dates only" (issue #1668): pure translation of a stay.
 * Every cent is frozen — booking totals, per-guest priceCents, per-night
 * BookingGuestNight.priceCents, promo rows, payment and Xero are all untouched
 * — and the stay is moved by a whole-day delta with its night count preserved.
 * Intended for operational relocations (e.g. a road closure) where the member
 * must not be charged. No settlement, change fee, Stripe or Xero calls.
 *
 * The caller (route) guarantees the actor is an admin; this asserts it anyway.
 */
export async function adminShiftBookingDates({
  bookingId,
  actor,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  input: {
    checkIn?: string;
    checkOut?: string;
    confirmOverCapacity?: boolean;
    notifyMember?: boolean;
  };
  ipAddress: string;
}): Promise<DateModificationResponse> {
  if (actor.role !== "ADMIN") {
    throw new ApiError("Admin override is not available for this account", 403);
  }
  // Owner decision (#1668 review): the admin chooses whether the member is
  // emailed about the change; absent means notify (no silent default).
  const notifyMember = input.notifyMember !== false;

  const result = await prisma.$transaction(async (tx) => {
    // Pre-lock read of only the lock key; lodgeId is immutable.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: {
          include: { nights: { select: { stayDate: true, priceCents: true } } },
        },
        payment: true,
        member: true,
      },
    });
    if (!booking) {
      throw new ApiError("Booking not found", 404);
    }

    // Negotiated-price (booking-request) bookings stay out of scope — same
    // block/message as every standard edit path.
    await assertBookingNotQuotePriced(tx, bookingId);

    if (!canModifyBookingStatusForRole(booking.status, "ADMIN")) {
      throw new ApiError(
        "This booking cannot be modified in its current status",
        400,
      );
    }
    const editPolicy = getBookingEditPolicy({
      status: booking.status,
      role: "ADMIN",
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adminOverride: true,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }

    // Resolve target dates with night-count parity. All date math is date-only:
    // both bounds are normalised to UTC midnight first, so the delta and every
    // shift are DST-safe (addDaysDateOnly for shifting, never raw ms on unnorm-
    // alised Dates).
    const oldCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
    const oldCheckOut = normalizeDateOnlyForTimeZone(booking.checkOut);
    const originalNightCount = eachDateOnlyInRange(oldCheckIn, oldCheckOut).length;

    const providedCheckIn = input.checkIn ? parseDateOnly(input.checkIn) : null;
    const providedCheckOut = input.checkOut ? parseDateOnly(input.checkOut) : null;
    if (
      (providedCheckIn && Number.isNaN(providedCheckIn.getTime())) ||
      (providedCheckOut && Number.isNaN(providedCheckOut.getTime()))
    ) {
      throw new ApiError("Invalid booking dates", 400);
    }

    let newCheckIn: Date;
    let newCheckOut: Date;
    if (providedCheckIn && providedCheckOut) {
      newCheckIn = providedCheckIn;
      newCheckOut = providedCheckOut;
    } else if (providedCheckIn) {
      // Derive the missing check-out to preserve the original length.
      newCheckIn = providedCheckIn;
      newCheckOut = addDaysDateOnly(providedCheckIn, originalNightCount);
    } else if (providedCheckOut) {
      newCheckOut = providedCheckOut;
      newCheckIn = addDaysDateOnly(providedCheckOut, -originalNightCount);
    } else {
      throw new ApiError("Provide a new check-in or check-out date", 400);
    }

    if (newCheckOut <= newCheckIn) {
      throw new ApiError("Check-out must be after check-in", 400);
    }
    const newNightCount = eachDateOnlyInRange(newCheckIn, newCheckOut).length;
    if (newNightCount !== originalNightCount) {
      throw new ApiError(SHIFT_LENGTH_MISMATCH_MESSAGE, 400);
    }
    if (
      newCheckIn.getTime() === oldCheckIn.getTime() &&
      newCheckOut.getTime() === oldCheckOut.getTime()
    ) {
      throw new ApiError("The booking already has these dates", 400);
    }

    // Whole-day delta between two UTC-midnight date-only values (DST-safe).
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const deltaDays = Math.round(
      (newCheckIn.getTime() - oldCheckIn.getTime()) / MS_PER_DAY,
    );

    // Translate every guest's envelope and night rows by the same delta; each
    // stored night keeps its exact priceCents (partial stays and gaps move with
    // the stay). Guests with no night rows keep envelope-only semantics.
    const translatedGuests = booking.guests.map((guest) => ({
      guest,
      stayStart: addDaysDateOnly(
        normalizeDateOnlyForTimeZone(guest.stayStart),
        deltaDays,
      ),
      stayEnd: addDaysDateOnly(
        normalizeDateOnlyForTimeZone(guest.stayEnd),
        deltaDays,
      ),
      nights: guest.nights.map((night) => ({
        stayDate: addDaysDateOnly(
          normalizeDateOnlyForTimeZone(night.stayDate),
          deltaDays,
        ),
        priceCents: night.priceCents,
      })),
    }));

    const capacityRanges = translatedGuests.map((entry) => ({
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights.map((night) => night.stayDate),
    }));

    // Non-lifecycle statuses (DRAFT, WAITLISTED, WAITLIST_OFFERED, BUMPED) hold
    // no capacity, so a shift cannot overbook — skip the check exactly like the
    // recalculate path's skipBookingLifecycleRules does, or the admin would be
    // forced through a meaningless over-capacity confirm and the audit would
    // record a capacityOverridden that overbooked nothing.
    const capacity = usesActiveBookingEditLifecycle(booking.status)
      ? await checkCapacityForGuestRanges(
          bookingLodgeId,
          newCheckIn,
          newCheckOut,
          capacityRanges,
          bookingId,
          tx,
        )
      : { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
    let capacityOverridden = false;
    if (!capacity.available) {
      if (!input.confirmOverCapacity) {
        throw new OverCapacityConfirmationRequiredError(
          overCapacityNights(capacity),
        );
      }
      capacityOverridden = true;
    }

    await assertNoBookingMemberNightConflicts(tx, {
      actorMemberId: actor.id,
      actorRole: "ADMIN",
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      guests: capacityRanges,
      excludeBookingId: bookingId,
    });

    // Writes: translate each guest's envelope and rebuild its night rows at the
    // shifted dates with the SAME priceCents. Guest priceCents is untouched.
    for (const entry of translatedGuests) {
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: { stayStart: entry.stayStart, stayEnd: entry.stayEnd },
      });
      await tx.bookingGuestNight.deleteMany({
        where: { bookingGuestId: entry.guest.id },
      });
      if (entry.nights.length > 0) {
        await tx.bookingGuestNight.createMany({
          data: entry.nights.map((night) => ({
            bookingGuestId: entry.guest.id,
            stayDate: night.stayDate,
            priceCents: night.priceCents,
          })),
        });
      }
    }

    // Non-member hold recalculation, mirroring modifyBookingDates: the hold
    // window and the PENDING → PAYMENT_PENDING release both key off the new
    // check-in. Status is otherwise unchanged.
    const hasNonMembers = booking.guests.some((guest) => !guest.isMember);
    let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
    let newStatus = booking.status;
    if (hasNonMembers) {
      const holdPolicy = await getNonMemberHoldPolicy(newCheckIn, booking.lodgeId);
      const holdDecision = calculateBookingHoldDecision({
        hasNonMembers,
        checkIn: newCheckIn,
        holdDays: holdPolicy.holdDays,
        holdEnabled: holdPolicy.enabled,
      });
      if (holdDecision.shouldBePending) {
        newNonMemberHoldUntil = new Date(
          newCheckIn.getTime() - holdPolicy.holdDays * 24 * 60 * 60 * 1000,
        );
      } else {
        newNonMemberHoldUntil = null;
        if (booking.status === "PENDING") {
          newStatus = "PAYMENT_PENDING";
        }
      }
    } else {
      newNonMemberHoldUntil = null;
    }

    // Update the booking envelope ONLY — every price field is left as booked.
    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        nonMemberHoldUntil: newNonMemberHoldUntil,
        status: newStatus,
      },
      include: { guests: true, payment: true },
    });

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

    await reconcileBedAllocationsForBooking({
      bookingId,
      db: tx,
      previousRange: { checkIn: oldCheckIn, checkOut: oldCheckOut },
    });

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "ADMIN_DATE_SHIFT",
        previousData: {
          checkIn: formatDateOnly(oldCheckIn),
          checkOut: formatDateOnly(oldCheckOut),
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
        },
        newData: {
          checkIn: formatDateOnly(newCheckIn),
          checkOut: formatDateOnly(newCheckOut),
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
          pricingMode: "shift",
          capacityOverridden,
        },
        priceDiffCents: 0,
        changeFeeCents: 0,
      },
    });

    await assertBookingEnvelopeInvariants(tx);

    return {
      booking: updatedBooking,
      oldCheckIn,
      oldCheckOut,
      newCheckIn,
      newCheckOut,
      capacityOverridden,
      choreWarnings,
      bookingModificationId: bookingModification.id,
      memberId: booking.memberId,
      memberEmail: booking.member.email,
      memberFirstName: booking.member.firstName,
      guestCount: booking.guests.length,
      finalPriceCents: booking.finalPriceCents,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      paymentSource: booking.payment?.source ?? null,
      lodgeId: booking.lodgeId,
    };
  });

  // Post-transaction (no Stripe/Xero/payment mutations at all).
  const linkedChangeRequestId = await linkModificationToOutstandingChangeRequest(
    prisma,
    bookingId,
    result.bookingModificationId,
  );

  const overrideAuditPayload = {
    pricingMode: "shift",
    confirmOverCapacity: Boolean(input.confirmOverCapacity),
    notifyMember,
    capacityOverridden: result.capacityOverridden,
    linkedChangeRequestId,
    oldCheckIn: formatDateOnly(result.oldCheckIn),
    oldCheckOut: formatDateOnly(result.oldCheckOut),
    newCheckIn: formatDateOnly(result.newCheckIn),
    newCheckOut: formatDateOnly(result.newCheckOut),
  };
  logAudit({
    action: "booking.modify.admin_override",
    memberId: actor.id,
    targetId: bookingId,
    subjectMemberId: result.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Admin override: booking dates shifted",
    details: JSON.stringify(overrideAuditPayload),
    metadata: { bookingId, ...overrideAuditPayload },
    ipAddress,
  });

  // Owner decision (#1668 review): the admin explicitly chose in the override
  // dialog whether to send the change email; the choice is audited above.
  if (notifyMember) {
    sendBookingModifiedEmail({
      email: result.memberEmail,
      firstName: result.memberFirstName,
      modificationType: "DATE_CHANGE",
      oldCheckIn: result.oldCheckIn,
      oldCheckOut: result.oldCheckOut,
      newCheckIn: result.newCheckIn,
      newCheckOut: result.newCheckOut,
      oldGuestCount: result.guestCount,
      newGuestCount: result.guestCount,
      oldFinalPriceCents: result.finalPriceCents,
      newFinalPriceCents: result.finalPriceCents,
      changeFeeCents: 0,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      additionalAmountCents: 0,
      additionalPaymentMethod: undefined,
      paymentReference: result.paymentReference,
      xeroInvoiceNumber: result.xeroInvoiceNumber,
      lodgeId: result.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send admin override date-shift email"),
    );
  }

  // Free the old range for the waitlist (unconditional on a change, matching the
  // standard date path).
  processWaitlistForDates({
    checkIn: result.oldCheckIn,
    checkOut: result.oldCheckOut,
    lodgeId: result.lodgeId,
  }).catch((err) =>
    logger.error({ err, bookingId }, "Failed to process waitlist after admin date shift"),
  );

  return {
    booking: result.booking,
    priceDiffCents: 0,
    changeFeeCents: 0,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    settlementMethod: null,
    policyRetainedAmountCents: 0,
    additionalAmountCents: 0,
    additionalPaymentClientSecret: null,
    stripeRefundId: null,
    promoRemoved: false,
    choreWarnings: result.choreWarnings,
    capacityOverridden: result.capacityOverridden,
  };
}
