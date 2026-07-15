import { NextRequest, NextResponse } from "next/server";
import {
  PaymentSource,
  type AgeTier,
  type BookingGuest,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  getDefaultLodgeCapacity,
  getLodgeCapacity,
} from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
} from "@/lib/policies/booking-route-decisions";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { ApiError as SharedApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import logger from "@/lib/logger";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { parseJsonRequestBody } from "@/lib/api-json";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { nameField } from "@/lib/zod-helpers";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import {
  assertBookingNotQuotePriced,
  lockedNightPricesForGuest,
} from "@/lib/booking-modify";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getSeasonYear } from "@/lib/utils";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
} from "@/lib/access-roles";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";

const addGuestsSchema = z.object({
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      })
    )
    .min(1)
    .max(200),
  // #1769b (#1705 semantics): per-action member-email choice on this
  // dual-actor route. Absent = notify (default); false suppresses the
  // booking-modified email. Only an admin actor may carry it (403 gate
  // below); a non-boolean value is rejected with the schema 400.
  notifyMember: z.boolean().optional(),
});

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);
  const actorRole = authorizationRoleFromAccessRoles(session.user);

  const { id: bookingId } = await params;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = addGuestsSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // #1769b (#1705 semantics): only an admin actor may carry the per-action
  // member-email choice on this dual-actor route. A member self-service caller
  // carrying the flag is refused, so a member can never suppress their own
  // booking-modified email; member behaviour is otherwise unchanged.
  if (parsed.data.notifyMember !== undefined && !isAdmin) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 }
    );
  }
  // Absent for any non-admin caller (defence in depth behind the 403 gate).
  const notifyMember = isAdmin ? parsed.data.notifyMember : undefined;

  const { guests: newGuests } = parsed.data;
  const payloadCapacity = await getDefaultLodgeCapacity();
  if (newGuests.length > payloadCapacity) {
    return NextResponse.json(
      {
        error: "Invalid input",
        details: {
          formErrors: [],
          fieldErrors: {
            guests: [`A booking cannot exceed ${payloadCapacity} guests`],
          },
        },
      },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the booking's lodge before re-reading it; the booking's lodge
      // cannot change, so the pre-read outside the lock is safe for key
      // selection.
      const lockTarget = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true },
      });
      const bookingLodgeId =
        lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

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

      if (
        booking.memberId !== session.user.id &&
        !isAdmin
      ) {
        throw new ApiError("Forbidden", 403);
      }

      if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
        throw new ApiError(
          "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
          400
        );
      }

      const editPolicy = getBookingEditPolicy({
        status: booking.status,
        role: actorRole,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      });
      if (!editPolicy.canModify) {
        throw new ApiError(
          editPolicy.reason ?? "This booking cannot be modified",
          400
        );
      }
      await assertBookingNotQuotePriced(tx, bookingId);
      if (editPolicy.mode !== "future") {
        throw new ApiError(
          "Use the full booking edit flow for in-progress booking guest changes",
          400
        );
      }

      const lodgeCapacity = await getLodgeCapacity(bookingLodgeId, tx);
      if (booking.guests.length + newGuests.length > lodgeCapacity) {
        throw new ApiError(
          `A booking cannot exceed ${lodgeCapacity} guests`,
          400,
        );
      }

      // Normalization can widen a linked guest's tier to the member's
      // stored AgeTier, so the element type widens ageTier (only) beyond
      // the bookable-tier zod inference.
      let normalizedNewGuests: Array<
        Omit<(typeof newGuests)[number], "ageTier"> & { ageTier: AgeTier }
      > = newGuests;
      try {
        const linkedMembers = await resolveLinkedBookingMembers(
          tx,
          booking.memberId,
          newGuests.map((guest) => guest.memberId),
          { skipAuthorization: isAdmin }
        );
        await assertLinkedBookingMembersCanBeBooked(
          tx,
          linkedMembers,
          session.user.id,
          {
            actorRole,
            onBehalfOfMemberId: isAdmin ? booking.memberId : null,
          }
        );
        normalizedNewGuests = normalizeBookingGuestInputs(newGuests, linkedMembers);
      } catch (error) {
        if (error instanceof BookingGuestValidationError) {
          throw error;
        }
        throw error;
      }

      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: session.user.id,
        actorRole,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: normalizedNewGuests,
        excludeBookingId: bookingId,
      });

      const seasonYear = getSeasonYear(booking.checkIn);
      await assertMembershipTypeBookingAllowed(tx, {
        ownerMemberId: booking.memberId,
        guests: [
          ...booking.guests,
          ...normalizedNewGuests.map((guest) => ({
            isMember: guest.isMember,
            memberId: guest.memberId ?? null,
          })),
        ],
        seasonYear,
      });

      if (!isAdmin) {
        const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
          bookingMemberId: booking.memberId,
          checkIn: booking.checkIn,
          guests: normalizedNewGuests,
        });

        if (unpaidMemberGuests.length > 0) {
          throw new ApiError(
            `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
            403
          );
        }
      }

      // Capacity check excluding this booking (using tx to participate in advisory lock)
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        [
          ...booking.guests,
          ...normalizedNewGuests.map(() => ({
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
          })),
        ],
        bookingId,
        tx
      );

      if (!capacity.available) {
        throw new ApiError(
          "Not enough beds available to add these guests",
          400
        );
      }

      // Load seasons for pricing
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

      // Calculate price for new guests
      const newGuestInputs = normalizedNewGuests.map((g) => ({
        ageTier: g.ageTier as AgeTier,
        isMember: g.isMember,
        memberId: g.memberId ?? null,
      }));

      // Price the whole post-add party together (#1095): the group discount
      // depends on party size per night, so a new guest joining a qualifying
      // party must price at the discounted rate — a standalone new-guest
      // pricing pass can never see the party. Existing guests are fully
      // locked (#1036), so the new guests' slices of this breakdown are
      // exactly their own prices.
      const allGuestsForPricing = [
        ...booking.guests.map((g) => ({
          bookingGuestId: g.id,
          ageTier: g.ageTier as AgeTier,
          isMember: g.isMember,
          memberId: g.memberId ?? null,
          // Price existing guests over exactly the nights they hold (#1093):
          // their stored night set (or stay envelope for pre-#713 guests
          // without rows), never the full booking range — a partial-stay
          // guest must not grow phantom nights because someone else was added.
          stayStart: g.stayStart,
          stayEnd: g.stayEnd,
          nights: g.nights && g.nights.length > 0 ? g.nights : null,
          // Existing guests keep their booked nightly prices (#1036): adding
          // a guest must cost exactly the added guest's own price.
          lockedNightPrices: lockedNightPricesForGuest(g),
        })),
        ...newGuestInputs,
      ];
      const requiresAdminReview = requiresAdultSupervisionReview(allGuestsForPricing);
      const adminReviewReason = requiresAdminReview
        ? ADULT_SUPERVISION_REVIEW_REASON
        : null;

      const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
        where: { id: "default" },
      });

      let fullPriceBreakdown;
      try {
        fullPriceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
          ownerMemberId: booking.memberId,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: allGuestsForPricing,
          seasons: seasonRateData,
          groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
          seasonYear,
        });
      } catch (error) {
        if (error instanceof MembershipTypeBookingPolicyError) {
          throw error;
        }
        throw new ApiError(
          "No season rate found for the booking dates",
          400
        );
      }

      // Create BookingGuest records from their slice of the full-party
      // breakdown, persisting one BookingGuestNight row per priced night
      // (#1093) so added guests join the uniform night-row model: without
      // rows, a later edit would reprice their whole stay at current season
      // rates instead of honouring the prices they booked at (#1036).
      const createdGuests: BookingGuest[] = [];
      for (let i = 0; i < normalizedNewGuests.length; i++) {
        const priced = fullPriceBreakdown.guests[booking.guests.length + i];
        const guest = await tx.bookingGuest.create({
          data: {
            bookingId,
            firstName: normalizedNewGuests[i].firstName,
            lastName: normalizedNewGuests[i].lastName,
            ageTier: normalizedNewGuests[i].ageTier,
            isMember: normalizedNewGuests[i].isMember,
            memberId: normalizedNewGuests[i].memberId || null,
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
            priceCents: priced.priceCents,
            nights: {
              create: (priced.nightDates ?? []).map((stayDate, k) => ({
                stayDate,
                priceCents: priced.perNightCents[k] ?? 0,
              })),
            },
          },
        });
        createdGuests.push(guest);
      }

      const guestNightRates = allGuestsForPricing.map((guest, index) => ({
        bookingGuestId:
          index < booking.guests.length
            ? booking.guests[index].id
            : createdGuests[index - booking.guests.length]?.id ?? null,
        memberId: guest.memberId ?? null,
        isMember: guest.isMember,
        perNightRates: fullPriceBreakdown.guests[index].perNightCents,
        nightDates: fullPriceBreakdown.guests[index].nightDates,
        // nightDates carry each guest's actual priced nights (partial stays
        // included); firstNight remains the booking's check-in so internal
        // work-party promos date their window from the stay start.
        firstNight: booking.checkIn,
      }));

      const newTotalPriceCents = fullPriceBreakdown.totalPriceCents;

      // Recalculate promo discount
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
          { excludeBookingId: bookingId, db: tx, selectedGuestIndexes, lodgeId: bookingLodgeId }
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

      // Update hasNonMembers
      const addingNonMembers = normalizedNewGuests.some((g) => !g.isMember);
      const hasNonMembers = booking.hasNonMembers || addingNonMembers;

      // Recalculate member-priority hold state if this edit leaves non-members
      // on a pre-payment booking. Disabled or inside-window holds are cleared.
      let nonMemberHoldUntil = booking.nonMemberHoldUntil;
      let holdAdjustedStatus = booking.status;
      if (
        hasNonMembers &&
        (booking.status === "PENDING" || booking.status === "PAYMENT_PENDING")
      ) {
        const holdPolicy = await getNonMemberHoldPolicy(
          booking.checkIn,
          booking.lodgeId,
        );
        const holdDecision = calculateBookingHoldDecision({
          hasNonMembers,
          checkIn: booking.checkIn,
          holdDays: holdPolicy.holdDays,
          holdEnabled: holdPolicy.enabled,
        });
        if (holdDecision.shouldBePending && booking.status === "PENDING") {
          nonMemberHoldUntil = new Date(
            new Date(booking.checkIn).getTime() -
              holdPolicy.holdDays * 24 * 60 * 60 * 1000
          );
        } else {
          nonMemberHoldUntil = null;
          if (booking.status === "PENDING") {
            holdAdjustedStatus = "PAYMENT_PENDING";
          }
        }
      } else if (!hasNonMembers) {
        nonMemberHoldUntil = null;
      }

      // Calculate additional amount for confirmed+paid bookings
      let additionalAmountCents = 0;
      const hasSettledPayment =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";
      const hasSucceededPayment =
        hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE;
      const hasIssuedXeroInvoice =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        !!booking.payment?.xeroInvoiceId;

      if ((hasSucceededPayment || hasIssuedXeroInvoice) && priceDiffCents > 0) {
        additionalAmountCents = priceDiffCents;
      }

      // This route only adds guests, so the no-adult rule can only
      // change from flagged → cleared (by adding an adult). When that
      // happens, wipe the review state and release the booking from
      // AWAITING_REVIEW. The rule cannot newly trip through this route.
      const reviewCleared = booking.requiresAdminReview && !requiresAdminReview;
      const reviewFieldUpdates = reviewCleared
        ? {
            requiresAdminReview: false,
            adminReviewReason: null,
            memberReviewJustification: null,
            adminReviewStatus: null,
            adminReviewNotes: null,
            adminReviewedById: null,
            adminReviewedAt: null,
          }
        : {
            requiresAdminReview,
            adminReviewReason,
          };

      const newStatus =
        reviewCleared && booking.status === "AWAITING_REVIEW"
          ? "PAYMENT_PENDING"
          : holdAdjustedStatus;

      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          promoAdjustmentCents: newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          status: newStatus,
          ...reviewFieldUpdates,
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

      // Create BookingModification record
      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
          modificationType: "GUEST_ADD",
          previousData: {
            guestCount: booking.guests.length,
            totalPriceCents: booking.totalPriceCents,
            discountCents: booking.discountCents,
            promoAdjustmentCents: booking.promoAdjustmentCents,
            finalPriceCents: booking.finalPriceCents,
          },
          newData: {
            guestCount: updatedBooking.guests.length,
            addedGuests: normalizedNewGuests.map((g) => ({
              firstName: g.firstName,
              lastName: g.lastName,
              ageTier: g.ageTier,
              isMember: g.isMember,
            })),
            totalPriceCents: newTotalPriceCents,
            discountCents: newDiscountCents,
            promoAdjustmentCents: newPromoAdjustmentCents,
            finalPriceCents: newFinalPriceCents,
          },
          priceDiffCents,
          changeFeeCents: 0,
        },
      });

      return {
        booking: updatedBooking,
        addedGuests: createdGuests,
        priceDiffCents,
        additionalAmountCents,
        promoRemoved,
        oldGuestCount: booking.guests.length,
        hasSucceededPayment,
        hasIssuedXeroInvoice,
        paymentStatus: booking.payment?.status ?? null,
        paymentSource: booking.payment?.source ?? null,
        paymentReference: booking.payment?.reference ?? null,
        xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
        paymentId: booking.payment?.id ?? null,
        paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
        memberEmail: booking.member.email,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberId: booking.memberId,
        addedGuestNames: normalizedNewGuests.map((guest) => `${guest.firstName} ${guest.lastName}`),
        bookingModificationId: bookingModification.id,
      };
    });

    // Create additional PaymentIntent for price increases (outside transaction
    // to avoid holding the advisory lock). Shared settlement helper (#1096):
    // a transient Stripe failure enqueues a durable recovery operation keyed
    // to this modification instead of only logging.
    const { additionalPaymentClientSecret, additionalPaymentIntentId } =
      await createModificationAdditionalPaymentIntent({
        bookingId,
        // Guest adds never decrease the price, so the shared settlement
        // context's refund side is always zero here.
        result: { ...result, pendingRefundAmountCents: 0 },
        reason: "guest_add_price_increase",
        idempotencyKey: `mod_guest_${bookingId}_${result.bookingModificationId}`,
        failureMessage:
          "Failed to create additional PaymentIntent for guest addition",
      });

    // Audit log
    logAudit({
      action: "booking.modify.guests.add",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guests added",
      details: JSON.stringify({
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
      }),
      metadata: {
        bookingId,
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
        newGuestCount: result.booking.guests.length,
        // #1769b honesty rule: the guest-add modified email always sends when a
        // member exists, so record the notify choice whenever it was
        // suppressed (notifyMember === false already implies admin via the 403
        // gate above).
        ...(notifyMember === false ? { notifyMember: false } : {}),
      },
      ipAddress,
    });

    void queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId: result.bookingModificationId,
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
      requiresAdditionalStripePayment:
        result.hasIssuedXeroInvoice && result.priceDiffCents > 0 && result.hasSucceededPayment,
      additionalPaymentIntentId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest addition")
    );

    // Send email
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member && notifyMember !== false) {
      sendBookingModifiedEmail({
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_ADD",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: 0,
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
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    return NextResponse.json({
      booking: result.booking,
      addedGuests: result.addedGuests,
      priceDiffCents: result.priceDiffCents,
      additionalAmountCents: result.additionalAmountCents,
      additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
      promoRemoved: result.promoRemoved,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(err),
        { status: err.status }
      );
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Shared-lib domain errors (e.g. the #1032 quote-priced edit block from
    // assertBookingNotQuotePriced) are the shared ApiError class, distinct
    // from this route's local ApiError above.
    if (err instanceof SharedApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err, bookingId }, "Failed to add guests to booking");
    return NextResponse.json(
      { error: "Failed to add guests" },
      { status: 400 }
    );
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
