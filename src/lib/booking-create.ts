/**
 * Booking creation service.
 *
 * The POST /api/bookings route handler used to mix request parsing,
 * auth gates, capacity locking, pricing, promo/credit, persistence,
 * payment-flow decisions, audit, and Xero queueing in one file. This
 * service owns the business orchestration: it takes already-validated
 * inputs (member resolved, dates parsed, guests normalized), runs the
 * appropriate transaction, and returns either a created booking or a
 * structured outcome the route handler turns into an HTTP response.
 *
 * Conventions preserved:
 *   - money values stay integer cents
 *   - booking dates stay NZ date-only (Date with time set to 00:00)
 *   - external network calls (email, Xero) stay outside long DB
 *     transactions (fired-and-forget after commit)
 *   - the single advisory lock key=1 still serialises ALL booking
 *     creation transactions to keep capacity checks safe
 */
import {
  AgeTier,
  BookingStatus,
  PromoCodeType,
  type Booking,
  type BookingGuest,
} from "@prisma/client";
import { eachDayOfInterval, subDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingCreditApplication,
  priceBookingGuests,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { checkCapacity, getOccupiedBedsForNight } from "@/lib/capacity";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  validatePromoCodeRules,
  redeemPromoCode,
  calculatePromoDiscountForGuestRates,
  getMemberFreeNightsUsed,
  getUniqueMemberRedemptionCount,
} from "@/lib/promo";
import {
  bumpPendingBookings,
  sendBumpedNotifications,
} from "@/lib/bumping";
import {
  sendAdminNewBookingAlert,
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
  sendWaitlistConfirmationEmail,
} from "@/lib/email";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { applyCreditToBooking, getMemberCreditBalance } from "@/lib/member-credit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { isFeatureEnabled } from "@/config/features";
import type { GroupDiscountConfig } from "@/lib/pricing";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";

type BookingWithGuests = Booking & { guests: BookingGuest[] };

export interface BookingGuestInput {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
}

interface BaseInput {
  effectiveMemberId: string;
  isOnBehalf: boolean;
  sessionUserId: string;
  checkIn: Date;
  checkOut: Date;
  guests: BookingGuestInput[];
  notes?: string;
  promoCodeStr?: string;
  expectedArrivalTime?: string;
  groupDiscount?: GroupDiscountConfig;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  applyCreditCents?: number;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  allMembers: boolean;
}

export type ConfirmedBookingOutcome =
  | { type: "created"; booking: BookingWithGuests; bumpedBookingIds: string[]; isZeroDollarConfirmed: boolean }
  | { type: "capacityExceeded"; fullNights: string[] };

export type WaitlistedBookingInput = BaseInput;

export interface WaitlistedBookingResult {
  booking: BookingWithGuests;
  position: number;
}

/**
 * Thrown when promo code validation fails inside the booking transaction.
 * The route handler turns this into a 400 response.
 */
export class BookingPromoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPromoError";
  }
}

interface ResolvedPromo {
  discountCents: number;
  promoFreeNightsUsed: number;
  promoEligibleGuestCount: number;
  promoCodeRecord:
    | {
        id: string;
        type: PromoCodeType;
        valueCents: number | null;
        percentOff: number | null;
        freeNightsPerIndividual: number | null;
        maxGuestsPerBooking: number | null;
        maxNightlyValueCents: number | null;
        memberGuestsOnly: boolean;
      }
    | null;
}

type LockedPromoRow = {
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
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  code: string;
};

/**
 * Resolve and validate a promo code inside the booking transaction.
 * Locks the row for update so concurrent bookings cannot over-redeem.
 * Throws BookingPromoError on validation failure so the caller can
 * roll back and return a 400.
 */
async function resolvePromoInTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  options: {
    promoCodeStr: string;
    effectiveMemberId: string;
    checkIn: Date;
    guests: BookingGuestInput[];
    totalPriceCents: number;
    perNightCentsByGuest: number[][];
  },
): Promise<ResolvedPromo> {
  const { promoCodeStr, effectiveMemberId, checkIn, guests, totalPriceCents, perNightCentsByGuest } = options;
  const normalizedCode = promoCodeStr.toUpperCase().trim();
  const lockedRows = await tx.$queryRaw<LockedPromoRow[]>`
    SELECT * FROM "PromoCode" WHERE "code" = ${normalizedCode} FOR UPDATE
  `;
  const promoCode = lockedRows.length > 0 ? lockedRows[0] : null;

  const needsMemberCount = Boolean(
    promoCode &&
      ((promoCode.maxUsesPerMember !== null && promoCode.maxUsesPerMember !== undefined) ||
        (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined)),
  );
  const memberRedemptionCount = needsMemberCount && promoCode
    ? await tx.promoRedemption.count({
        where: { promoCodeId: promoCode.id, memberId: effectiveMemberId },
      })
    : 0;

  let memberFreeNightsUsed = 0;
  if (promoCode?.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual) {
    const result = await tx.promoRedemption.aggregate({
      where: { promoCodeId: promoCode.id, memberId: effectiveMemberId },
      _sum: { freeNightsUsed: true },
    });
    memberFreeNightsUsed = result._sum.freeNightsUsed ?? 0;
  }

  let uniqueMembersUsed = 0;
  if (promoCode?.maxUniqueMembersTotal !== null && promoCode?.maxUniqueMembersTotal !== undefined) {
    const rows = await tx.promoRedemption.findMany({
      where: { promoCodeId: promoCode.id },
      select: { memberId: true },
      distinct: ["memberId"],
    });
    uniqueMembersUsed = rows.length;
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

  const validationError = validatePromoCodeRules(
    promoCode,
    { memberId: effectiveMemberId, bookingCheckIn: checkIn },
    new Date(),
    {
      memberRedemptionCount,
      memberFreeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: memberRedemptionCount > 0,
    },
    assignedMemberIds,
  );
  if (validationError) {
    throw new BookingPromoError(validationError);
  }

  const remainingFreeNights =
    promoCode?.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual
      ? promoCode.freeNightsPerIndividual - memberFreeNightsUsed
      : undefined;
  const guestNightRates = guests.map((guest, index) => ({
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: perNightCentsByGuest[index],
  }));
  const promoResult = calculatePromoDiscountForGuestRates(
    {
      type: promoCode!.type,
      valueCents: promoCode!.valueCents,
      percentOff: promoCode!.percentOff,
      freeNightsPerIndividual: promoCode!.freeNightsPerIndividual,
      maxGuestsPerBooking: promoCode!.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode!.maxNightlyValueCents,
      memberGuestsOnly: promoCode!.memberGuestsOnly,
    },
    totalPriceCents,
    effectiveMemberId,
    guestNightRates,
    assignedMemberIds,
    remainingFreeNights,
  );

  return {
    discountCents: promoResult.discountCents,
    promoFreeNightsUsed: promoResult.freeNightsUsed,
    promoEligibleGuestCount: promoResult.eligibleGuestCount,
    promoCodeRecord: promoCode,
  };
}

function buildGuestCreateData(guests: BookingGuestInput[], price: { guests: { priceCents: number }[] }, checkIn: Date, checkOut: Date) {
  return guests.map((g, i) => ({
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: g.isMember,
    memberId: g.memberId || null,
    stayStart: checkIn,
    stayEnd: checkOut,
    priceCents: price.guests[i].priceCents,
  }));
}

/**
 * Create a DRAFT booking. Skips capacity locking, payment, Xero, and
 * email side effects — drafts only persist the booking + pricing + an
 * audit entry. Throws BookingPromoError if the promo code fails
 * validation.
 */
export async function createDraftBooking(input: DraftBookingInput): Promise<BookingWithGuests> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    groupDiscount,
  } = input;

  const requiresAdminReview = requiresAdultSupervisionReview(guests);
  const adminReviewReason = requiresAdminReview ? ADULT_SUPERVISION_REVIEW_REASON : null;

  const newBooking = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const draftExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    const seasons = await tx.season.findMany({
      where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
      include: { rates: true },
    });
    const seasonData = toSeasonRateData(seasons);
    const guestInputs = toGuestPricingInputs(guests);
    const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

    let discountCents = 0;
    let promoFreeNightsUsed = 0;
    let promoEligibleGuestCount = 0;
    let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
    if (promoCodeStr) {
      const resolved = await resolvePromoInTransaction(tx, {
        promoCodeStr,
        effectiveMemberId,
        checkIn,
        guests,
        totalPriceCents: price.totalPriceCents,
        perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
      });
      discountCents = resolved.discountCents;
      promoFreeNightsUsed = resolved.promoFreeNightsUsed;
      promoEligibleGuestCount = resolved.promoEligibleGuestCount;
      promoCodeRecord = resolved.promoCodeRecord;
    }

    const finalPriceCents = price.totalPriceCents - discountCents;
    const hasNonMembers = guests.some((g) => !g.isMember);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
        checkIn,
        checkOut,
        status: BookingStatus.DRAFT,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        draftExpiresAt,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview,
        adminReviewReason,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && discountCents > 0) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
      );
    }

    return createdBooking;
  });

  logAudit({
    action: "booking.created",
    memberId: sessionUserId,
    targetId: newBooking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Draft booking created",
    details: "Draft booking created",
    metadata: {
      status: newBooking.status,
      onBehalf: isOnBehalf,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: guests.length,
      hasNonMembers: guests.some((guest) => !guest.isMember),
      finalPriceCents: newBooking.finalPriceCents,
    },
  });

  if (isOnBehalf) {
    logAudit({
      action: "booking.created_on_behalf",
      memberId: sessionUserId,
      targetId: newBooking.id,
      subjectMemberId: effectiveMemberId,
      entityType: "Booking",
      entityId: newBooking.id,
      category: "booking",
      outcome: "success",
      summary: "Draft booking created on behalf of member",
      details: `Admin created draft booking on behalf of member ${effectiveMemberId}`,
      metadata: {
        status: newBooking.status,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        guestCount: guests.length,
        hasNonMembers: guests.some((guest) => !guest.isMember),
      },
    });
  }

  return newBooking;
}

/**
 * Create a CONFIRMED/PENDING/PAYMENT_PENDING/PAID booking with capacity
 * locking, pricing, promo/credit, and post-commit side effects.
 *
 * Returns `{ type: "capacityExceeded", fullNights }` instead of throwing
 * when the request would oversell — the route handler turns that into
 * the 409 capacity-exceeded response and can offer the waitlist option.
 */
export async function createConfirmedBooking(input: ConfirmedBookingInput): Promise<ConfirmedBookingOutcome> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    applyCreditCents,
    groupDiscount,
    status,
    shouldBePending,
    holdDays,
    allMembers,
  } = input;

  const hasNonMembers = guests.some((g) => !g.isMember);
  const requiresAdminReview = requiresAdultSupervisionReview(guests);
  const adminReviewReason = requiresAdminReview ? ADULT_SUPERVISION_REVIEW_REASON : null;

  let bumpedBookingIds: string[] = [];
  let isZeroDollarConfirmed = false;
  let capacityFullNights: string[] | null = null;

  let booking: BookingWithGuests;
  try {
    booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const nights = eachDayOfInterval({ start: checkIn, end: subDays(checkOut, 1) });

      const overlappingBookings = await tx.booking.findMany({
        where: {
          checkIn: { lt: checkOut },
          checkOut: { gt: checkIn },
          status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
        },
        include: { guests: true },
      });

      const nightDetails: Array<{ date: string; occupiedBeds: number; availableBeds: number }> = [];
      let capacityExceeded = false;
      for (const night of nights) {
        const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);
        nightDetails.push({
          date: night.toISOString().split("T")[0],
          occupiedBeds,
          availableBeds: LODGE_CAPACITY - occupiedBeds,
        });
        if (occupiedBeds + guests.length > LODGE_CAPACITY) {
          capacityExceeded = true;
        }
      }

      const seasons = await tx.season.findMany({
        where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
        include: { rates: true },
      });
      const seasonData = toSeasonRateData(seasons);
      const guestInputs = toGuestPricingInputs(guests);
      const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

      let discountCents = 0;
      let promoFreeNightsUsed = 0;
      let promoEligibleGuestCount = 0;
      let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
      if (promoCodeStr) {
        const resolved = await resolvePromoInTransaction(tx, {
          promoCodeStr,
          effectiveMemberId,
          checkIn,
          guests,
          totalPriceCents: price.totalPriceCents,
          perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
        });
        discountCents = resolved.discountCents;
        promoFreeNightsUsed = resolved.promoFreeNightsUsed;
        promoEligibleGuestCount = resolved.promoEligibleGuestCount;
        promoCodeRecord = resolved.promoCodeRecord;
      }

      const finalPriceCents = price.totalPriceCents - discountCents;
      const creditBalance =
        (applyCreditCents ?? 0) > 0 && status === BookingStatus.PAYMENT_PENDING
          ? await getMemberCreditBalance(effectiveMemberId, tx)
          : 0;
      const { creditAppliedCents, effectivePriceCents } = calculateBookingCreditApplication({
        requestedCreditCents: applyCreditCents ?? 0,
        creditBalanceCents: creditBalance,
        finalPriceCents,
        status,
      });

      if (capacityExceeded && (status === BookingStatus.PENDING || effectivePriceCents > 0)) {
        capacityFullNights = nightDetails
          .filter((n) => n.availableBeds < guests.length)
          .map((n) => n.date);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      const nonMemberHoldUntil = shouldBePending
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: effectiveMemberId,
          checkIn,
          checkOut,
          status,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          finalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          notes: notes || null,
          expectedArrivalTime: expectedArrivalTime || null,
          createdById: isOnBehalf ? sessionUserId : null,
          requiresAdminReview,
          adminReviewReason,
          guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
        },
        include: { guests: true },
      });

      if (promoCodeRecord && discountCents > 0) {
        await redeemPromoCode(
          tx,
          promoCodeRecord.id,
          newBooking.id,
          effectiveMemberId,
          discountCents,
          promoFreeNightsUsed || undefined,
          promoEligibleGuestCount || undefined,
        );
      }

      if (creditAppliedCents > 0) {
        await applyCreditToBooking(effectiveMemberId, creditAppliedCents, newBooking.id, tx);
      }

      // Zero-dollar (or fully credit-covered) PAYMENT_PENDING booking:
      // final-claim capacity, create $0 SUCCEEDED Payment, set PAID.
      if (effectivePriceCents === 0 && status === BookingStatus.PAYMENT_PENDING) {
        const capacityCheck = await checkCapacity(checkIn, checkOut, guests.length, newBooking.id, tx);
        if (!capacityCheck.available) {
          if (!allMembers) {
            capacityFullNights = capacityCheck.nightDetails
              .filter((night) => night.availableBeds < guests.length)
              .map((night) => night.date.toISOString().split("T")[0]);
            throw new Error("CAPACITY_EXCEEDED_SENTINEL");
          }

          const bumpResult = await bumpPendingBookings(checkIn, checkOut, guests.length, tx);
          if (!bumpResult.capacityRestored) {
            capacityFullNights = capacityCheck.nightDetails
              .filter((night) => night.availableBeds < guests.length)
              .map((night) => night.date.toISOString().split("T")[0]);
            throw new Error("CAPACITY_EXCEEDED_SENTINEL");
          }

          bumpedBookingIds = bumpResult.bumpedBookingIds;
        }

        isZeroDollarConfirmed = true;
        await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: 0,
            creditAppliedCents,
            status: "SUCCEEDED",
          },
        });
        await tx.booking.update({
          where: { id: newBooking.id },
          data: { status: BookingStatus.PAID },
        });
        newBooking.status = BookingStatus.PAID;
      }

      return newBooking;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "CAPACITY_EXCEEDED_SENTINEL" && capacityFullNights) {
      return { type: "capacityExceeded", fullNights: capacityFullNights };
    }
    throw err;
  }

  logAudit({
    action: "booking.created",
    memberId: sessionUserId,
    targetId: booking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: booking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking created",
    details: `Booking created with status ${booking.status}`,
    metadata: {
      status: booking.status,
      onBehalf: isOnBehalf,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: guests.length,
      hasNonMembers,
      finalPriceCents: booking.finalPriceCents,
      zeroDollarConfirmed: isZeroDollarConfirmed,
    },
  });

  if (isOnBehalf) {
    logAudit({
      action: "booking.created_on_behalf",
      memberId: sessionUserId,
      targetId: booking.id,
      subjectMemberId: effectiveMemberId,
      entityType: "Booking",
      entityId: booking.id,
      category: "booking",
      outcome: "success",
      summary: "Booking created on behalf of member",
      details: `Admin created booking on behalf of member ${effectiveMemberId}`,
      metadata: {
        status: booking.status,
        checkIn: checkIn.toISOString(),
        checkOut: checkOut.toISOString(),
        guestCount: guests.length,
        hasNonMembers,
        finalPriceCents: booking.finalPriceCents,
      },
    });
  }

  if (bumpedBookingIds.length > 0) {
    const triggeringMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    const triggeringName = triggeringMember
      ? `${triggeringMember.firstName} ${triggeringMember.lastName}`
      : "Unknown";
    sendBumpedNotifications(bumpedBookingIds, triggeringName).catch((err) =>
      logger.error({ err }, "Failed to send bump notifications"),
    );
  }

  if (isZeroDollarConfirmed) {
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: { member: true, guests: true, promoRedemption: { include: { promoCode: true } } },
      });
      if (fullBooking) {
        sendBookingConfirmedEmail(
          fullBooking.member.email,
          fullBooking.member.firstName,
          fullBooking.checkIn,
          fullBooking.checkOut,
          fullBooking.guests.length,
          fullBooking.finalPriceCents,
          fullBooking.discountCents > 0
            ? { discountCents: fullBooking.discountCents, promoCode: fullBooking.promoRedemption?.promoCode?.code }
            : undefined,
        ).catch((err) => logger.error({ err, bookingId: booking.id }, "Failed to send confirmation email for $0 booking"));

        if (isFeatureEnabled("xeroIntegration")) {
          void enqueueXeroBookingInvoiceOperation(booking.id, { createdByMemberId: sessionUserId })
            .then(async (queuedInvoice) => {
              if (!queuedInvoice.queueOperationId) return;
              await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
            })
            .catch((err) =>
              logger.error({ err, bookingId: booking.id }, "Failed to queue Xero invoice for $0 booking"),
            );
        }
      }
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Error in post-creation handling for $0 booking");
    }
  }

  if (booking.status === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
    const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    if (member) {
      sendBookingPendingEmail(
        member.email,
        member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.nonMemberHoldUntil,
      ).catch((err) => logger.error({ err }, "Failed to send pending booking email"));
    }
  }

  const bookingMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
  if (bookingMember) {
    sendAdminNewBookingAlert({
      memberName: `${bookingMember.firstName} ${bookingMember.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      totalCents: booking.finalPriceCents,
      status: booking.status,
      reviewReason: booking.adminReviewReason,
    }).catch((err) => logger.error({ err }, "Failed to send admin new booking alert"));
  }

  return { type: "created", booking, bumpedBookingIds, isZeroDollarConfirmed };
}

/**
 * Create a WAITLISTED booking when capacity is full and the user has
 * opted in. Pricing is locked in at waitlist time. Position is set
 * inside the transaction so it remains stable until the booking is
 * promoted off the waitlist.
 */
export async function createWaitlistedBooking(input: WaitlistedBookingInput): Promise<WaitlistedBookingResult> {
  const {
    effectiveMemberId,
    isOnBehalf,
    sessionUserId,
    checkIn,
    checkOut,
    guests,
    notes,
    promoCodeStr,
    expectedArrivalTime,
    groupDiscount,
  } = input;

  const seasons = await prisma.season.findMany({
    where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
    include: { rates: true },
  });
  const seasonData = toSeasonRateData(seasons);
  const guestInputs = toGuestPricingInputs(guests);
  const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

  let discountCents = 0;
  let promoFreeNightsUsed = 0;
  let promoEligibleGuestCount = 0;
  let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;

  if (promoCodeStr) {
    const normalizedCode = promoCodeStr.toUpperCase().trim();
    const promoCode = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: { assignments: { select: { memberId: true } } },
    });
    const needsMemberCount = Boolean(
      promoCode &&
        ((promoCode.maxUsesPerMember !== null && promoCode.maxUsesPerMember !== undefined) ||
          (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined)),
    );
    const memberRedemptionCount = needsMemberCount && promoCode
      ? await prisma.promoRedemption.count({
          where: { promoCodeId: promoCode.id, memberId: effectiveMemberId },
        })
      : 0;
    let memberFreeNightsUsed = 0;
    if (promoCode?.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual) {
      memberFreeNightsUsed = await getMemberFreeNightsUsed(promoCode.id, effectiveMemberId);
    }
    let uniqueMembersUsed = 0;
    if (promoCode?.maxUniqueMembersTotal !== null && promoCode?.maxUniqueMembersTotal !== undefined) {
      uniqueMembersUsed = await getUniqueMemberRedemptionCount(promoCode.id);
    }
    const assignedMemberIds = promoCode?.assignments?.length
      ? promoCode.assignments.map((a) => a.memberId)
      : null;
    const validationError = validatePromoCodeRules(
      promoCode,
      { memberId: effectiveMemberId, bookingCheckIn: checkIn },
      new Date(),
      {
        memberRedemptionCount,
        memberFreeNightsUsed,
        uniqueMembersUsed,
        memberHasRedeemedBefore: memberRedemptionCount > 0,
      },
      assignedMemberIds,
    );
    if (validationError) {
      throw new BookingPromoError(validationError);
    }
    const remainingFreeNights =
      promoCode?.type === "FREE_NIGHTS" && promoCode.freeNightsPerIndividual
        ? promoCode.freeNightsPerIndividual - memberFreeNightsUsed
        : undefined;
    const guestNightRates = guests.map((guest, index) => ({
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: price.guests[index].perNightCents,
    }));
    const promoResult = calculatePromoDiscountForGuestRates(
      {
        type: promoCode!.type,
        valueCents: promoCode!.valueCents,
        percentOff: promoCode!.percentOff,
        freeNightsPerIndividual: promoCode!.freeNightsPerIndividual,
        maxGuestsPerBooking: promoCode!.maxGuestsPerBooking,
        maxNightlyValueCents: promoCode!.maxNightlyValueCents,
        memberGuestsOnly: promoCode!.memberGuestsOnly,
      },
      price.totalPriceCents,
      effectiveMemberId,
      guestNightRates,
      assignedMemberIds,
      remainingFreeNights,
    );
    discountCents = promoResult.discountCents;
    promoFreeNightsUsed = promoResult.freeNightsUsed;
    promoEligibleGuestCount = promoResult.eligibleGuestCount;
    promoCodeRecord = promoCode;
  }

  const finalPriceCents = price.totalPriceCents - discountCents;
  const hasNonMembers = guests.some((g) => !g.isMember);
  const requiresAdminReview = requiresAdultSupervisionReview(guests);
  const adminReviewReason = requiresAdminReview ? ADULT_SUPERVISION_REVIEW_REASON : null;

  const { newBooking, position } = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
        checkIn,
        checkOut,
        status: BookingStatus.WAITLISTED,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview,
        adminReviewReason,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && discountCents > 0) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
      );
    }

    const waitlistPosition =
      (await tx.booking.count({
        where: {
          status: BookingStatus.WAITLISTED,
          checkIn: { lt: createdBooking.checkOut },
          checkOut: { gt: createdBooking.checkIn },
          createdAt: { lt: createdBooking.createdAt },
        },
      })) + 1;

    const updatedBooking = await tx.booking.update({
      where: { id: createdBooking.id },
      data: { waitlistPosition },
      include: { guests: true },
    });

    return { newBooking: updatedBooking, position: waitlistPosition };
  });

  const member = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
  if (member) {
    sendWaitlistConfirmationEmail(
      member.email,
      member.firstName,
      checkIn,
      checkOut,
      newBooking.guests.length,
      position,
    ).catch((err) => logger.error({ err }, "Failed to send waitlist confirmation email"));

    sendAdminNewBookingAlert({
      memberName: `${member.firstName} ${member.lastName}`,
      checkIn: newBooking.checkIn,
      checkOut: newBooking.checkOut,
      guestCount: newBooking.guests.length,
      totalCents: newBooking.finalPriceCents,
      status: newBooking.status,
      reviewReason: newBooking.adminReviewReason,
    }).catch((err) => logger.error({ err }, "Failed to send admin alert for waitlisted booking"));
  }

  logAudit({
    action: "booking.waitlisted",
    memberId: effectiveMemberId,
    targetId: newBooking.id,
    subjectMemberId: effectiveMemberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Booking added to waitlist",
    details: `Booking added to waitlist at position #${position}`,
    metadata: {
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: newBooking.guests.length,
      position,
      finalPriceCents: newBooking.finalPriceCents,
      requiresAdminReview: newBooking.requiresAdminReview,
    },
  });

  return { booking: newBooking, position };
}
