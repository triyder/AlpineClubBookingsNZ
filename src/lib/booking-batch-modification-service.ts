import {
  type Booking,
  type BookingGuest,
  type Payment,
  PaymentSource,
  type PaymentStatus,
  type Role,
} from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api-error";
import {
  applyChoreCleanup,
  applyGuestChanges,
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  applyPromoCodeChanges,
  assertBookingModifiable,
  calculateModificationSettlementOptions,
  calculateModificationChangeFee,
  calculateModifiedPricing,
  loadActiveSeasonRates,
  prepareGuestPlan,
  resolveGuestNameUpdates,
  resolveTargetDates,
  type BatchModifyInput,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
  type ResolvedGuestNameUpdate,
  type PricingResult,
  isBookingFullyPaidForGuestNameEdits,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
} from "@/lib/booking-modify";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";
import { getDefaultLodgeId } from "@/lib/lodges";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import {
  sendAdminMinorsOnlyReviewAlert,
  sendBookingModifiedEmail,
} from "@/lib/email";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  minorsReviewAlertShouldFire,
} from "@/lib/booking-review";
import logger from "@/lib/logger";
import { createBookingModificationCredit } from "@/lib/member-credit";
import { prisma } from "@/lib/prisma";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate,
} from "@/lib/xero-period-lock-guard";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type BatchModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    promoRemoved: boolean;
    promoChanged: boolean;
    choreWarnings: string[];
    datesChanged: boolean;
    adminOverride: boolean;
    notifyMember: boolean;
    capacityOverridden: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    oldGuestCount: number;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    zeroDollarAutoPaid: boolean;
    supersededPrimaryPaymentIntents: { length: number };
    xeroAdditionalAmountCents: number;
    xeroRefundAmountCents: number;
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    guestNameUpdates: ResolvedGuestNameUpdate[];
    guestIdentityChanged: boolean;
    identityOnlyModification: boolean;
    // #1372: this edit newly dropped a paid (capacity-holding) booking into the
    // blocked minors-only review state, so the post-tx step alerts admins.
    minorsOnlyReviewNewlyFlagged: boolean;
  };

export type BatchModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  additionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoChanged: boolean;
  choreWarnings: string[];
};

/**
 * Pricing echo for identity-only modifications (#1099): stored totals,
 * per-guest prices, and night rows exactly as persisted, in booking-guest
 * order (matching proposedRemainingGuests when nothing is added or removed).
 * Guests without night rows (quoted or pre-#713 bookings) echo empty night
 * arrays, which the guest-sync step treats as "leave the rows alone".
 */
function buildIdentityOnlyPricing(booking: LoadedBookingForModify): PricingResult {
  return {
    inProgressPlan: null,
    capacityOverridden: false,
    newTotalPriceCents: booking.totalPriceCents,
    priceBreakdown: {
      totalPriceCents: booking.totalPriceCents,
      guests: booking.guests.map((guest) => ({
        priceCents: guest.priceCents,
        perNightCents: (guest.nights ?? []).map((night) => night.priceCents ?? 0),
        nightDates: (guest.nights ?? []).map((night) => night.stayDate),
      })),
    },
    guestNightRates: booking.guests.map((guest) => ({
      bookingGuestId: guest.id,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: (guest.nights ?? []).map((night) => night.priceCents ?? 0),
      nightDates: (guest.nights ?? []).map((night) => night.stayDate),
    })),
  };
}

export async function modifyBookingBatch({
  bookingId,
  actor,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  input: BatchModifyInput;
  ipAddress: string;
}): Promise<BatchModificationResponse> {
  // Issue #1668: admin-only date override. The route also rejects non-admins,
  // but keep the service guard so the invariant holds however it is called.
  if (input.adminOverride && actor.role !== "ADMIN") {
    throw new ApiError("Admin override is not available for this account", 403);
  }
  const adminOverride = Boolean(input.adminOverride) && actor.role === "ADMIN";
  // #1746: partner-shared admission is admin-initiated by owner decision —
  // the reserved slots (#1745) must be unreachable from member self-service
  // however the service is called.
  if (input.partnerSharedGuests?.length && actor.role !== "ADMIN") {
    throw new ApiError(
      "Partner-shared placement is not available for this account",
      403,
    );
  }
  // Owner decision (#1668/#1696): an admin chooses per edit whether the member is
  // emailed — on override AND plain edits — with absent meaning notify. A
  // non-admin actor can never suppress (the route 403s any notify flag), so they
  // always notify (unchanged).
  const notifyMember =
    actor.role !== "ADMIN" ? true : input.notifyMember !== false;
  if (adminOverride) {
    // Date-only contract: an override edit may change ONLY the dates. Any guest
    // or promo input is rejected so preview/apply mirroring stays tractable.
    if (
      input.addGuests?.length ||
      input.removeGuestIds?.length ||
      input.guestStayRanges?.length ||
      input.guestUpdates?.length ||
      input.promoCode ||
      input.promoGuestIndexes?.length ||
      input.removePromoCode
    ) {
      throw new ApiError("Admin override edits change dates only", 400);
    }
    if (!input.pricingMode) {
      throw new ApiError("Choose a pricing mode for the admin override", 400);
    }
    // "shift" is dispatched to adminShiftBookingDates at the route and must
    // never reach the recalculate machinery here.
    if (input.pricingMode === "shift") {
      throw new ApiError(
        "Shift-mode admin overrides are applied through the date-shift path",
        400,
      );
    }
    // Xero lock-date guard (#1697): a recalculate override can queue a
    // check-in-dated primary-invoice write (date/narration update on unpaid
    // bookings; create on zero-dollar ones), so the proposed check-in must
    // clear the effective lock date — same semantics as the retroactive
    // create (#1695). Deliberately conservative: it fires on every recalculate
    // override even when the settlement would only write today-dated documents
    // (decision on #1697, re-affirmed on #1718). Shift mode writes no Xero
    // documents and is never guarded. Runs before the transaction: the Xero
    // call must stay outside it, and the pre-read is only advisory (the outbox
    // still fails safely if the lock dates change mid-flight).
    await assertProposedCheckInClearsXeroLockDate(
      prisma,
      bookingId,
      input.checkIn,
    );
  } else {
    // Ordinary edits (#1729) get the NARROW guard instead, also before the
    // transaction: it consults the lock dates only when this edit would
    // actually queue the check-in-dated invoice update (issued Xero invoice +
    // dates changing + payment not settled — the settlement classifier's own
    // predicate), with member-appropriate error text for non-admin actors.
    // Identity-only edits (guest name fixes, no date fields) never trigger
    // it — the outbox backstop covers that rare strand instead of blocking a
    // typo fix.
    await assertProposedDateEditClearsXeroLockDate(
      prisma,
      bookingId,
      { checkIn: input.checkIn, checkOut: input.checkOut },
      {
        audience: actor.role === "ADMIN" ? "admin" : "member",
        actorMemberId: actor.id,
      },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; the eligibility checks, pricing, capacity
    // check and claim below all run against the post-lock re-read.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; everything below consumes ONLY
    // this post-lock snapshot.
    const booking = (await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        // Per-night sets (issue #713): preserve unedited guests' gaps and
        // re-sync edited guests' nights.
        guests: { include: { nights: { select: { stayDate: true, priceCents: true } } } },
        payment: true,
        member: true,
        promoRedemption: {
          include: {
            promoCode: {
              include: {
                assignments: { select: { memberId: true } },
                lodges: { select: { lodgeId: true } },
              },
            },
            guestTargets: { select: { bookingGuestId: true } },
          },
        },
      },
    })) as LoadedBookingForModify | null;

    assertBookingModifiable(booking, {
      role: actor.role,
      actorId: actor.id,
    });
    // Identity-only requests (guest name fixes, nothing structural) never
    // reprice (#1099), so they are allowed on quote-priced bookings: the
    // negotiated basis cannot be disturbed by an edit that skips the pricing
    // engine entirely.
    const requestedStructuralChange = Boolean(
      input.checkIn ||
        input.checkOut ||
        input.addGuests?.length ||
        input.removeGuestIds?.length ||
        input.guestStayRanges?.length ||
        input.promoCode ||
        input.removePromoCode,
    );
    const requestIsIdentityOnly =
      !requestedStructuralChange && Boolean(input.guestUpdates?.length);
    const quotePriced = await isQuotePricedBooking(tx, bookingId);
    if (!requestIsIdentityOnly && quotePriced) {
      throw new ApiError(QUOTE_PRICED_EDIT_BLOCK_MESSAGE, 400);
    }

    const dates = resolveTargetDates({
      booking,
      role: actor.role,
      input,
    });

    const guestPlan = await prepareGuestPlan(tx, {
      booking,
      role: actor.role,
      actorId: actor.id,
      input,
      isInProgressEdit: dates.isInProgressEdit,
      editableFrom: dates.editableFrom,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
    });
    const guestNameUpdates = resolveGuestNameUpdates({
      booking,
      input,
      // Quoted bookings rename placeholder students even after payment.
      allowWhenFullyPaid: quotePriced,
      // Identity-only edits on a fully-paid booking may fix a spelling typo on a
      // free-text non-member guest (#1386); a swap to a different person is
      // still rejected. Never loosen structural edits — hence identity-only.
      allowTypoFixWhenFullyPaid: requestIsIdentityOnly,
    });
    const identityOnlyModification =
      guestNameUpdates.length > 0 && !requestedStructuralChange;
    // A fully-paid, non-quoted booking whose name edit cleared the typo guard
    // (#1386): flag it so the audit row is queryable and the price-preserving
    // path is provably taken (it never reprices or rechecks capacity).
    const paidNameTypoFix =
      identityOnlyModification &&
      !quotePriced &&
      isBookingFullyPaidForGuestNameEdits(booking);

    // Identity-only modifications are price-preserving by construction
    // (#1099): the stored totals, per-guest prices, and night rows are echoed
    // back instead of running the pricing engine, so a name fix can never
    // move money — not on quoted bookings (no per-tier basis to reprice
    // from), not on legacy bookings without night rows, not across a season
    // rate change. The promo is equally untouched: nothing promo-relevant
    // changes when a name does.
    const pricing = identityOnlyModification
      ? buildIdentityOnlyPricing(booking)
      : await calculateModifiedPricing(tx, {
          booking,
          bookingId,
          isInProgressEdit: dates.isInProgressEdit,
          editableFrom: dates.editableFrom,
          newCheckIn: dates.newCheckIn,
          newCheckOut: dates.newCheckOut,
          normalizedAddGuests: guestPlan.normalizedAddGuests,
          removeGuestIds: input.removeGuestIds,
          guestsForPricing: guestPlan.guestsForPricing,
          skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
          // Multi-lodge: season rates are resolved for the booking's lodge.
          seasonRateData: await loadActiveSeasonRates(tx, bookingLodgeId),
          // Issue #1668: over-capacity warns-and-confirms under admin override.
          adminOverride,
          confirmOverCapacity: input.confirmOverCapacity,
          // #1746: admin-flagged partner-sharers route capacity through the
          // #1745 reserved-slot check (gated to ADMIN actors above).
          partnerSharedGuests: input.partnerSharedGuests,
        });

    const promo = identityOnlyModification
      ? {
          newDiscountCents: booking.discountCents,
          newPromoAdjustmentCents: booking.promoAdjustmentCents,
          promoRemoved: false,
          promoChanged: false,
        }
      : await applyPromoCodeChanges(tx, {
          booking,
          bookingId,
          input,
          inProgressPlan: pricing.inProgressPlan,
          newCheckIn: dates.newCheckIn,
          newTotalPriceCents: pricing.newTotalPriceCents,
          guestNightRates: pricing.guestNightRates,
        });

    const newFinalPriceCents = pricing.newTotalPriceCents + promo.newPromoAdjustmentCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    const changeFeeCents = await calculateModificationChangeFee({
      booking,
      newCheckIn: dates.newCheckIn,
      checkInChanged: dates.checkInChanged,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
    });

    const settlementOptions = await calculateModificationSettlementOptions({
      booking,
      netChargeCents: priceDiffCents + changeFeeCents,
    });
    if (settlementOptions?.requiresSettlementMethod && !input.settlementMethod) {
      throw new ApiError("Choose a refund or account credit before saving", 400);
    }

    await applyGuestChanges(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      removedGuests: guestPlan.removedGuests,
      remainingGuests: guestPlan.remainingGuests,
      proposedRemainingGuests: guestPlan.proposedRemainingGuests,
      normalizedAddGuests: guestPlan.normalizedAddGuests,
      guestNameUpdates,
      priceBreakdown: pricing.priceBreakdown,
      inProgressPlan: pricing.inProgressPlan,
    });

    const choreWarnings = await applyChoreCleanup(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      datesChanged: dates.datesChanged,
    });

    const payments = await applyPaymentAdjustments(tx, {
      booking,
      priceDiffCents,
      changeFeeCents,
      settlementOptions,
      settlementMethod: input.settlementMethod,
    });

    const lifecycle = await applyLifecycleTransitions(tx, {
      booking,
      bookingId,
      newCheckIn: dates.newCheckIn,
      newFinalPriceCents,
      guestsForPricing: guestPlan.guestsForPricing,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      reviewUpdate: guestPlan.reviewUpdate,
    });

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: dates.newCheckIn,
        checkOut: dates.newCheckOut,
        totalPriceCents: pricing.newTotalPriceCents,
        discountCents: promo.newDiscountCents,
        promoAdjustmentCents: promo.newPromoAdjustmentCents,
        finalPriceCents: newFinalPriceCents,
        hasNonMembers: lifecycle.hasNonMembers,
        nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
        status: lifecycle.newStatus,
        requiresAdminReview: guestPlan.reviewUpdate.requiresAdminReview,
        adminReviewReason: guestPlan.reviewUpdate.adminReviewReason,
        memberReviewJustification: guestPlan.reviewUpdate.memberReviewJustification,
        adminReviewStatus: guestPlan.reviewUpdate.adminReviewStatus,
        adminReviewNotes: guestPlan.reviewUpdate.adminReviewNotes,
        adminReviewedById: guestPlan.reviewUpdate.adminReviewedById,
        adminReviewedAt: guestPlan.reviewUpdate.adminReviewedAt,
        // Persisted capacity override (#1771): this batch modification
        // re-evaluates capacity against the new nights/guests
        // (pricing.capacityOverridden from calculateModifiedPricing), so
        // RECONCILE the marker — stamp when admitted over capacity behind a
        // confirm, and CLEAR any prior stamp when the change moved the booking
        // back within capacity, so a stale flag can't suppress a legitimate
        // cancel on the new nights later.
        capacityOverriddenAt: pricing.capacityOverridden ? new Date() : null,
        capacityOverriddenByMemberId: pricing.capacityOverridden
          ? actor.id
          : null,
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
        memberId: actor.id,
        // GUEST_TYPO_FIX discriminates a post-payment spelling correction
        // (#1386) from an ordinary pre-payment name update, so the abuse-
        // sensitive path is queryable. (modificationType is a free-text String,
        // not a Prisma enum — no schema change.)
        modificationType: paidNameTypoFix
          ? "GUEST_TYPO_FIX"
          : identityOnlyModification
            ? "GUEST_UPDATE"
            : "BATCH_MODIFY",
        previousData: {
          checkIn: new Date(booking.checkIn).toISOString().split("T")[0],
          checkOut: new Date(booking.checkOut).toISOString().split("T")[0],
          guestCount: booking.guests.length,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
          removedGuests: guestPlan.removedGuests.map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
          updatedGuests: guestNameUpdates.map((update) => ({
            guestId: update.guestId,
            firstName: update.previousFirstName,
            lastName: update.previousLastName,
          })),
        },
        newData: {
          checkIn: dates.newCheckIn.toISOString().split("T")[0],
          checkOut: dates.newCheckOut.toISOString().split("T")[0],
          guestCount: updatedBooking.guests.length,
          addedGuests: (guestPlan.normalizedAddGuests ?? []).map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
          updatedGuests: guestNameUpdates.map((update) => ({
            guestId: update.guestId,
            firstName: update.firstName,
            lastName: update.lastName,
          })),
          totalPriceCents: pricing.newTotalPriceCents,
          discountCents: promo.newDiscountCents,
          promoAdjustmentCents: promo.newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          promoRemoved: promo.promoRemoved,
          promoChanged: promo.promoChanged,
          settlementMethod: payments.settlementMethod,
          accountCreditAmountCents: payments.accountCreditAmountCents,
          policyRetainedAmountCents: payments.policyRetainedAmountCents,
          // Post-payment identity-preserving spelling correction (#1386).
          ...(paidNameTypoFix ? { paidNameTypoFix: true } : {}),
          // Admin override recalculate (#1668).
          ...(adminOverride
            ? {
                adminOverride: true,
                pricingMode: "recalculate",
                capacityOverridden: pricing.capacityOverridden,
              }
            : {}),
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    if (payments.accountCreditAmountCents > 0) {
      await createBookingModificationCredit(
        booking.memberId,
        payments.accountCreditAmountCents,
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
      refundAmountCents: payments.refundAmountCents,
      accountCreditAmountCents: payments.accountCreditAmountCents,
      additionalAmountCents: payments.additionalAmountCents,
      pendingRefundAmountCents: payments.pendingRefundAmountCents,
      promoRemoved: promo.promoRemoved,
      promoChanged: promo.promoChanged,
      choreWarnings,
      datesChanged: dates.datesChanged,
      adminOverride,
      notifyMember,
      capacityOverridden: pricing.capacityOverridden,
      oldCheckIn: booking.checkIn,
      oldCheckOut: booking.checkOut,
      oldGuestCount: booking.guests.length,
      hasSucceededPayment: payments.hasSucceededPayment,
      hasIssuedXeroInvoice: payments.hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      paymentSource: booking.payment?.source ?? null,
      paymentReference: booking.payment?.reference ?? null,
      xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
      zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
      supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
      xeroAdditionalAmountCents: payments.xeroAdditionalAmountCents,
      xeroRefundAmountCents: payments.xeroRefundAmountCents,
      settlementMethod: payments.settlementMethod,
      policyRetainedAmountCents: payments.policyRetainedAmountCents,
      guestNameUpdates,
      guestIdentityChanged: guestNameUpdates.length > 0,
      identityOnlyModification,
      // #1372: newly blocked a paid booking on the minors-only rule? Computed
      // from the pre-edit review state and the freshly written booking.
      minorsOnlyReviewNewlyFlagged: minorsReviewAlertShouldFire({
        previous: booking,
        updated: updatedBooking,
      }),
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
    } satisfies BatchModificationTransactionResult;
  });

  await drainSupersededPrimaryIntents({
    bookingId,
    supersededPrimaryPaymentIntents: result.supersededPrimaryPaymentIntents,
  });

  const stripeRefundId = await executeBookingModificationRefund({
    bookingId,
    result,
    metadataReason: "batch_modification",
    idempotencyKeyPrefix: `mod_batch_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after batch modification - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue payment recovery for Stripe refund failure after batch modification",
  });

  const { additionalPaymentClientSecret, additionalPaymentIntentId } =
    await createModificationAdditionalPaymentIntent({
      bookingId,
      result,
      reason: "batch_modify_price_increase",
      idempotencyKey: `mod_batch_${bookingId}_${result.bookingModificationId}`,
      failureMessage: "Failed to create additional PaymentIntent for batch modification",
    });

  // Issue #1668: under an admin override, link this modification to the
  // booking's most recent approved-unlinked change request. Best-effort.
  const linkedChangeRequestId = result.adminOverride
    ? await linkModificationToOutstandingChangeRequest(prisma, {
        bookingId,
        modificationId: result.bookingModificationId,
        appliedCheckIn: result.booking.checkIn,
        appliedCheckOut: result.booking.checkOut,
      })
    : null;

  await dispatchBatchPostTransactionSideEffects({
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
    additionalAmountCents: result.additionalAmountCents,
    settlementMethod: result.settlementMethod,
    additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
    stripeRefundId: stripeRefundId ?? null,
    promoRemoved: result.promoRemoved,
    promoChanged: result.promoChanged,
    choreWarnings: result.choreWarnings,
  };
}

async function dispatchBatchPostTransactionSideEffects({
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
  result: BatchModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
  linkedChangeRequestId: string | null;
}): Promise<void> {
  const auditDetails = {
    datesChanged: result.datesChanged,
    oldGuestCount: result.oldGuestCount,
    newGuestCount: result.booking.guests.length,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    accountCreditAmountCents: result.accountCreditAmountCents,
    promoRemoved: result.promoRemoved,
    promoChanged: result.promoChanged,
    updatedGuestCount: result.guestNameUpdates.length,
    guestIdentityChanged: result.guestIdentityChanged,
    zeroDollarAutoPaid: result.zeroDollarAutoPaid,
    settlementMethod: result.settlementMethod,
    policyRetainedAmountCents: result.policyRetainedAmountCents,
    // Admin override recalculate (#1668): before/after dates, capacity decision
    // and the linked change request, so the override edit is fully auditable.
    // Issue #1696: a non-override admin edit that suppressed the member email
    // records notifyMember: false too (notifyMember is false only when an admin
    // opted out — members always notify), so every suppressed edit is auditable.
    ...(result.adminOverride
      ? {
          adminOverride: true,
          pricingMode: "recalculate" as const,
          confirmOverCapacity: result.capacityOverridden,
          notifyMember: result.notifyMember,
          capacityOverridden: result.capacityOverridden,
          oldCheckIn: new Date(result.oldCheckIn).toISOString().split("T")[0],
          oldCheckOut: new Date(result.oldCheckOut).toISOString().split("T")[0],
          newCheckIn: result.booking.checkIn.toISOString().split("T")[0],
          newCheckOut: result.booking.checkOut.toISOString().split("T")[0],
          linkedChangeRequestId,
        }
      : result.notifyMember
        ? {}
        : { notifyMember: false }),
  };

  logAudit({
    // Issue #1668: every override move audits under the one queryable action
    // name shared with the shift and modify-dates override paths.
    action: result.adminOverride
      ? "booking.modify.admin_override"
      : "booking.modify.batch",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: result.adminOverride
      ? "Admin override: booking dates recalculated"
      : "Booking modified",
    details: JSON.stringify(auditDetails),
    metadata: { bookingId, ...auditDetails },
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
    guestIdentityChanged: result.guestIdentityChanged,
    settlementMethod: result.settlementMethod,
    settlementAmountCents: result.xeroRefundAmountCents,
    createPrimaryInvoiceWhenMissing:
      result.zeroDollarAutoPaid && !result.hasIssuedXeroInvoice,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to queue Xero settlement for batch modification",
    ),
  );

  // #1372: an edit that dropped the last adult from a paid booking blocks its
  // lodge check-in (the booking KEEPS its PAID status). Nudge admins to review
  // it, best-effort — an email failure must never affect the completed edit.
  if (result.minorsOnlyReviewNewlyFlagged) {
    sendAdminMinorsOnlyReviewAlert({
      memberName: result.memberName,
      checkIn: result.booking.checkIn,
      checkOut: result.booking.checkOut,
      guestCount: result.booking.guests.length,
      reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    }).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to send minors-only review admin alert",
      ),
    );
  }

  if (result.identityOnlyModification) {
    return;
  }

  // Owner decision (#1668 review): an override admin may choose not to email
  // the member; the choice is recorded in the audit fields above.
  if (!result.notifyMember) {
    return;
  }

  const member = await prisma.member.findUnique({
    where: { id: result.booking.memberId },
  });
  if (!member) return;

  sendBookingModifiedEmail({
    email: member.email,
    firstName: member.firstName,
    modificationType: "BATCH_MODIFY",
    oldCheckIn: result.oldCheckIn,
    oldCheckOut: result.oldCheckOut,
    newCheckIn: result.booking.checkIn,
    newCheckOut: result.booking.checkOut,
    oldGuestCount: result.oldGuestCount,
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
    logger.error(
      { err, bookingId },
      "Failed to send batch modification email",
    ),
  );
}
