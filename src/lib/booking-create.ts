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
  AdminReviewStatus,
  AgeTier,
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type FixedNightlyMode,
  PromoCodeType,
  type Booking,
  type BookingGuest,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingCreditApplication,
  priceBookingGuests,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  redeemPromoCode,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import { resolveWorkPartyEventPromoForBooking } from "@/lib/work-party";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
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
import {
  buildInternetBankingPaymentReference,
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import { recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";
import { isFeatureEnabled } from "@/config/features";
import type { GroupDiscountConfig } from "@/lib/pricing";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import {
  addDaysDateOnly,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";

type BookingWithGuests = Booking & { guests: BookingGuest[] };

export interface BookingGuestInput {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). When present, the guest stays
  // exactly these nights (which may be non-contiguous) and stayStart/stayEnd
  // are the derived min/max envelope.
  nights?: ReadonlyArray<GuestNightInput> | null;
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
  promoGuestIndexes?: number[];
  // Work party (working bee) event the booker is attending. Mutually
  // exclusive with promoCodeStr; resolves to the event's internal promo.
  workPartyEventId?: string;
  expectedArrivalTime?: string;
  requestedRoomId?: string;
  // "Only book if my guests can come": cancel the whole booking instead of the
  // default partial bump when non-member guests lose capacity.
  cancelIfGuestsBumped?: boolean;
  groupDiscount?: GroupDiscountConfig;
  memberReviewJustification?: string;
  // Group booking (shareable join code): when set, the created (primary)
  // booking is linked to the organiser's booking via parentBookingId, so a
  // joiner's stay is grouped with the event. Existing callers leave this
  // undefined, which persists null exactly as before.
  parentBookingId?: string;
  // Group booking, ORGANISER_PAYS mode: when true the created booking is
  // flagged organiserSettled, so the joiner is never billed for it and cannot
  // pay it themselves; the organiser settles the group total. Only the
  // group-join path sets this; everyone else leaves it undefined (false).
  organiserSettled?: boolean;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  applyCreditCents?: number;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  paymentMethod?: BookingPaymentMethod;
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

/**
 * Thrown when the no-adult rule trips for a member-created booking but the
 * caller did not supply `memberReviewJustification`. Members must explain
 * why they are booking minors without an adult before the booking can be
 * persisted for admin review.
 */
export class BookingReviewJustificationRequiredError extends Error {
  constructor() {
    super(
      "A reason is required when booking minors without an adult guest. Please explain so an admin can review."
    );
    this.name = "BookingReviewJustificationRequiredError";
  }
}

/**
 * Resolve the admin-review fields for a booking based on guest mix and
 * whether the booking is being created by an admin on behalf of a member.
 *
 * Admin-created bookings auto-approve the review (no second pass on their
 * own work). Member-created bookings that trip the rule require a written
 * justification and land with adminReviewStatus = PENDING so an admin can
 * decide via the booking requests queue.
 */
function resolveAdminReviewFields(args: {
  guests: BookingGuestInput[];
  isOnBehalf: boolean;
  sessionUserId: string;
  memberReviewJustification: string | undefined;
}): {
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  memberReviewJustification: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  adminReviewNotes: string | null;
  adminReviewedById: string | null;
  adminReviewedAt: Date | null;
  blockForReview: boolean;
} {
  const flagged = requiresAdultSupervisionReview(args.guests);
  if (!flagged) {
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      blockForReview: false,
    };
  }

  if (args.isOnBehalf) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: args.memberReviewJustification?.trim() || null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at creation by admin.",
      adminReviewedById: args.sessionUserId,
      adminReviewedAt: new Date(),
      blockForReview: false,
    };
  }

  const justification = args.memberReviewJustification?.trim();
  if (!justification) {
    throw new BookingReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    blockForReview: true,
  };
}

interface ResolvedPromo {
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
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  code: string;
  assignedMembersOnlyOwnNights: boolean;
  internal: boolean;
};

function getPromoTargetBookingGuestIds(
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
async function resolvePromoInTransaction(
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

const PROMO_WORK_PARTY_EXCLUSION_MESSAGE =
  "A promo code cannot be combined with a working bee discount. Please remove one of them and try again.";

/**
 * Resolve the effective promo source for a booking: either the
 * member-entered code or the selected work party event's internal promo.
 * Only one PromoRedemption can exist per booking, so the two are mutually
 * exclusive. Throws BookingPromoError when both are supplied or the event
 * is not bookable for these dates.
 */
async function resolveEffectivePromoSource(
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

type PricedGuest = {
  priceCents: number;
  perNightCents: number[];
  nightDates: Date[];
};

/**
 * Build the nested guest create payload, including one BookingGuestNight row
 * per included night (issue #713). The guest's stayStart/stayEnd envelope is
 * derived from the priced nights (min night, last night + 1 day); a guest with
 * no priced nights falls back to the booking range. Every guest — contiguous or
 * not — gets per-night rows so the data model is uniform.
 */
export function buildGuestCreateData(
  guests: BookingGuestInput[],
  price: { guests: PricedGuest[] },
  checkIn: Date,
  checkOut: Date
) {
  return guests.map((g, i) => {
    const priced = price.guests[i];
    const nightDates = priced.nightDates ?? [];
    const hasNights = nightDates.length > 0;
    const stayStart = hasNights ? nightDates[0] : (g.stayStart ?? checkIn);
    const stayEnd = hasNights
      ? addDaysDateOnly(nightDates[nightDates.length - 1], 1)
      : (g.stayEnd ?? checkOut);
    return {
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId || null,
      stayStart,
      stayEnd,
      priceCents: priced.priceCents,
      nights: {
        create: nightDates.map((stayDate, k) => ({
          stayDate,
          priceCents: priced.perNightCents[k] ?? 0,
        })),
      },
    };
  });
}

/**
 * Remap promo-target guest indexes (which point into the full party guest list)
 * onto a subset of that list. Used when a mixed party is split so the promo,
 * which is applied to the member booking, targets the right member guests.
 * Indexes pointing at guests outside the subset (e.g. non-members) are dropped.
 */
function remapPromoIndexesToSubset(
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

function getCapacityGuestRanges(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
) {
  return guests.map((guest) => ({
    stayStart: guest.stayStart ?? checkIn,
    stayEnd: guest.stayEnd ?? checkOut,
    // Pass the explicit night set through so capacity counts a non-contiguous
    // guest only on the nights they actually stay (issue #713).
    nights: guest.nights ?? undefined,
  }));
}

/**
 * Resolve the booking's effective date envelope from its guests (issue #713).
 *
 * Creation is expand-only: the range never shrinks below the member's stated
 * checkIn/checkOut, but auto-expands to cover any guest night that falls
 * outside it. In single-range mode (no explicit night sets, guest dates within
 * the stated range) the result equals the stated range exactly, so existing
 * behaviour is unchanged. Manage-guests editing recomputes the envelope from
 * the night sets directly (allowing shrink) on its own path.
 */
function resolveBookingDateEnvelope(
  guests: BookingGuestInput[],
  checkIn: Date,
  checkOut: Date
): { checkIn: Date; checkOut: Date } {
  let minKey = formatDateOnly(checkIn);
  let maxNightKey = formatDateOnly(addDaysDateOnly(checkOut, -1));

  const consider = (start: Date, lastNight: Date) => {
    const startKey = formatDateOnly(start);
    const lastKey = formatDateOnly(lastNight);
    if (startKey < minKey) minKey = startKey;
    if (lastKey > maxNightKey) maxNightKey = lastKey;
  };

  for (const guest of guests) {
    if (guest.nights && guest.nights.length > 0) {
      for (const entry of guest.nights) {
        const night = normalizeNightEntryDate(entry);
        consider(night, night);
      }
    } else if (guest.stayStart && guest.stayEnd) {
      consider(
        normalizeDateOnlyForTimeZone(guest.stayStart),
        addDaysDateOnly(normalizeDateOnlyForTimeZone(guest.stayEnd), -1)
      );
    }
  }

  return {
    checkIn: normalizeDateOnlyForTimeZone(new Date(`${minKey}T00:00:00.000Z`)),
    checkOut: addDaysDateOnly(
      normalizeDateOnlyForTimeZone(new Date(`${maxNightKey}T00:00:00.000Z`)),
      1
    ),
  };
}

function normalizeNightEntryDate(entry: GuestNightInput): Date {
  if (typeof entry === "string") {
    return normalizeDateOnlyForTimeZone(new Date(`${entry}T00:00:00.000Z`));
  }
  if (entry instanceof Date) {
    return normalizeDateOnlyForTimeZone(entry);
  }
  return normalizeNightEntryDate(entry.stayDate);
}

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
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
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    groupDiscount,
    memberReviewJustification,
  } = input;
  // Auto-expand (issue #713): the persisted range covers every guest night,
  // never shrinking below the member's stated range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  // Member-created drafts that trip the no-adult rule land directly in
  // AWAITING_REVIEW: they hold capacity while the admin is deciding and
  // bypass the 72-hour draft expiry (which would otherwise delete them
  // mid-review). Admin-created drafts (auto-approved) stay as DRAFT.
  const draftStatus = review.blockForReview ? BookingStatus.AWAITING_REVIEW : BookingStatus.DRAFT;

  const newBooking = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const draftExpiresAt = review.blockForReview
      ? null
      : new Date(Date.now() + 72 * 60 * 60 * 1000);

    const seasons = await tx.season.findMany({
      where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
      include: { rates: true },
    });
    const seasonData = toSeasonRateData(seasons);
    const guestInputs = toGuestPricingInputs(guests);
    const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

    let discountCents = 0;
    let promoAdjustmentCents = 0;
    let promoFreeNightsUsed = 0;
    let promoEligibleGuestCount = 0;
    let promoAllocations: PromoBeneficiaryAllocation[] = [];
    let promoSelectedGuestIndexes: number[] | undefined;
    let promoShouldPersist = false;
    let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
    const promoSource = await resolveEffectivePromoSource(tx, {
      promoCodeStr,
      workPartyEventId,
      checkIn,
      checkOut,
    });
    if (promoSource) {
      const resolved = await resolvePromoInTransaction(tx, {
        promoCodeStr: promoSource.promoCodeStr,
        allowInternal: promoSource.allowInternal,
        effectiveMemberId,
        checkIn,
        guests,
        totalPriceCents: price.totalPriceCents,
        perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
        nightDatesByGuest: price.guests.map((g) => g.nightDates),
        promoGuestIndexes,
      });
      discountCents = resolved.discountCents;
      promoAdjustmentCents = resolved.promoAdjustmentCents;
      promoFreeNightsUsed = resolved.promoFreeNightsUsed;
      promoEligibleGuestCount = resolved.promoEligibleGuestCount;
      promoAllocations = resolved.promoAllocations;
      promoSelectedGuestIndexes = resolved.promoSelectedGuestIndexes;
      promoShouldPersist = resolved.promoShouldPersist;
      promoCodeRecord = resolved.promoCodeRecord;
    }

    const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
    const hasNonMembers = guests.some((g) => !g.isMember);

    const createdBooking = await tx.booking.create({
      data: {
        memberId: effectiveMemberId,
        checkIn,
        checkOut,
        status: draftStatus,
        totalPriceCents: price.totalPriceCents,
        discountCents,
        promoAdjustmentCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        draftExpiresAt,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        requestedRoomId: requestedRoomId || null,
        cancelIfGuestsBumped: cancelIfGuestsBumped ?? false,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview: review.requiresAdminReview,
        adminReviewReason: review.adminReviewReason,
        memberReviewJustification: review.memberReviewJustification,
        adminReviewStatus: review.adminReviewStatus,
        adminReviewNotes: review.adminReviewNotes,
        adminReviewedById: review.adminReviewedById,
        adminReviewedAt: review.adminReviewedAt,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && promoShouldPersist) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoAdjustmentCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
        promoAllocations,
        getPromoTargetBookingGuestIds(createdBooking.guests, promoSelectedGuestIndexes),
      );
    }

    await reconcileBedAllocationsForBooking({
      bookingId: createdBooking.id,
      db: tx,
    });

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

  await recordBookingEvent({
    bookingId: newBooking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: newBooking.finalPriceCents,
  });

  // Drafts that land directly in AWAITING_REVIEW skip the usual draft
  // flow — alert admins immediately so they can decide.
  if (review.blockForReview) {
    const draftMember = await prisma.member.findUnique({ where: { id: effectiveMemberId } });
    if (draftMember) {
      sendAdminNewBookingAlert({
        memberName: `${draftMember.firstName} ${draftMember.lastName}`,
        checkIn: newBooking.checkIn,
        checkOut: newBooking.checkOut,
        guestCount: newBooking.guests.length,
        totalCents: newBooking.finalPriceCents,
        status: newBooking.status,
        reviewReason: newBooking.adminReviewReason,
        memberJustification: newBooking.memberReviewJustification,
      }).catch((err) => logger.error({ err }, "Failed to send admin alert for awaiting-review draft"));
    }
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
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    applyCreditCents,
    groupDiscount,
    status,
    shouldBePending,
    holdDays,
    paymentMethod = DEFAULT_BOOKING_PAYMENT_METHOD,
    memberReviewJustification,
    parentBookingId,
    organiserSettled,
  } = input;
  // Auto-expand (issue #713): cover every guest night (members + non-members)
  // so the member booking and any linked non-member child share one range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  // Split-booking decision (#738). A mixed member/non-member party that is not
  // flagged becomes two linked bookings: the member portion is charged up front
  // and holds capacity (the parent), while the non-member portion is a
  // provisional PENDING child that holds nothing (resolved at the hold window
  // in R3). The flagged "only book if my guests can come" path stays a single
  // provisional PENDING booking holding nothing, nothing charged up front.
  // Pure parties stay a single booking. Bookings held for admin review are
  // never split — the whole party waits in AWAITING_REVIEW until an admin
  // decides.
  const memberGuests = guests.filter((g) => g.isMember);
  const nonMemberGuests = guests.filter((g) => !g.isMember);
  const hasMemberGuests = memberGuests.length > 0;
  const hasNonMemberGuests = nonMemberGuests.length > 0;
  const flaggedProvisional =
    (cancelIfGuestsBumped ?? false) && hasNonMemberGuests && !review.blockForReview;
  const splitBooking =
    hasMemberGuests &&
    hasNonMemberGuests &&
    !flaggedProvisional &&
    !review.blockForReview;

  // The primary (returned) booking. For a split it carries only the member
  // guests; the non-member guests become the linked child created in the same
  // transaction. Promo selection indexes are remapped onto the member subset.
  const primaryGuests = splitBooking ? memberGuests : guests;
  const primaryHasNonMembers = primaryGuests.some((g) => !g.isMember);
  const primaryPromoGuestIndexes = splitBooking
    ? remapPromoIndexesToSubset(promoGuestIndexes, guests, primaryGuests)
    : promoGuestIndexes;

  // A member-created youth-only booking lands in AWAITING_REVIEW regardless
  // of the caller's requested status — payment is intentionally blocked
  // until an admin approves.
  const internetBankingPaymentSelected =
    paymentMethod === "internet_banking" && !review.blockForReview;
  // Status of the primary booking. A split member booking is always charged up
  // front (a pure-member booking never holds as PENDING). The flagged path is
  // forced PENDING. Otherwise use the status the route computed for the party.
  const requestedStatus = flaggedProvisional
    ? BookingStatus.PENDING
    : splitBooking
      ? BookingStatus.PAYMENT_PENDING
      : internetBankingPaymentSelected
        ? BookingStatus.PAYMENT_PENDING
        : status;
  const effectiveStatus = review.blockForReview
    ? BookingStatus.AWAITING_REVIEW
    : requestedStatus;
  // A split member booking holds capacity and is never a provisional hold; the
  // flagged path is always a provisional hold.
  const primaryShouldBePending = flaggedProvisional
    ? true
    : splitBooking
      ? false
      : shouldBePending;

  let isZeroDollarConfirmed = false;
  let capacityFullNights: string[] | null = null;
  // Captured inside the transaction so the split child's CREATED event can be
  // written once, after commit (issue #740).
  let splitChild: { id: string; finalPriceCents: number } | null = null;

  let booking: BookingWithGuests;
  try {
    booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const capacityGuestRanges = getCapacityGuestRanges(primaryGuests, checkIn, checkOut);
      const capacityCheck = await checkCapacityForGuestRanges(
        checkIn,
        checkOut,
        capacityGuestRanges,
        undefined,
        tx
      );

      const seasons = await tx.season.findMany({
        where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
        include: { rates: true },
      });
      const seasonData = toSeasonRateData(seasons);
      const guestInputs = toGuestPricingInputs(primaryGuests);
      const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

      let discountCents = 0;
      let promoAdjustmentCents = 0;
      let promoFreeNightsUsed = 0;
      let promoEligibleGuestCount = 0;
      let promoAllocations: PromoBeneficiaryAllocation[] = [];
      let promoSelectedGuestIndexes: number[] | undefined;
      let promoShouldPersist = false;
      let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;
      const promoSource = await resolveEffectivePromoSource(tx, {
        promoCodeStr,
        workPartyEventId,
        checkIn,
        checkOut,
      });
      if (promoSource) {
        const resolved = await resolvePromoInTransaction(tx, {
          promoCodeStr: promoSource.promoCodeStr,
          allowInternal: promoSource.allowInternal,
          effectiveMemberId,
          checkIn,
          guests: primaryGuests,
          totalPriceCents: price.totalPriceCents,
          perNightCentsByGuest: price.guests.map((g) => g.perNightCents),
          nightDatesByGuest: price.guests.map((g) => g.nightDates),
          promoGuestIndexes: primaryPromoGuestIndexes,
        });
        discountCents = resolved.discountCents;
        promoAdjustmentCents = resolved.promoAdjustmentCents;
        promoFreeNightsUsed = resolved.promoFreeNightsUsed;
        promoEligibleGuestCount = resolved.promoEligibleGuestCount;
        promoAllocations = resolved.promoAllocations;
        promoSelectedGuestIndexes = resolved.promoSelectedGuestIndexes;
        promoShouldPersist = resolved.promoShouldPersist;
        promoCodeRecord = resolved.promoCodeRecord;
      }

      const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
      // Credit is only applied at payment time. For a booking heading to
      // AWAITING_REVIEW, defer credit application until the admin approves
      // and the member completes payment.
      const creditBalance =
        (applyCreditCents ?? 0) > 0 &&
        requestedStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
          ? await getMemberCreditBalance(effectiveMemberId, tx)
          : 0;
      const { creditAppliedCents, effectivePriceCents } = calculateBookingCreditApplication({
        requestedCreditCents: review.blockForReview ? 0 : (applyCreditCents ?? 0),
        creditBalanceCents: creditBalance,
        finalPriceCents,
        status: requestedStatus,
      });

      // AWAITING_REVIEW holds capacity, so capacity must be verified even
      // when the booking would otherwise have skipped the check (zero-dollar
      // member-paid path).
      if (
        !capacityCheck.available &&
        (requestedStatus === BookingStatus.PENDING || effectivePriceCents > 0 || review.blockForReview)
      ) {
        capacityFullNights = getCapacityFullNights(capacityCheck.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      const nonMemberHoldUntil = primaryShouldBePending && !internetBankingPaymentSelected
        ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
        : null;

      const newBooking = await tx.booking.create({
        data: {
          memberId: effectiveMemberId,
          checkIn,
          checkOut,
          status: effectiveStatus,
          totalPriceCents: price.totalPriceCents,
          discountCents,
          promoAdjustmentCents,
          finalPriceCents,
          hasNonMembers: primaryHasNonMembers,
          nonMemberHoldUntil,
          // Group join: link this joiner's booking to the organiser's booking.
          // Included only when supplied (the group-join path forbids mixed
          // guests). A normal or split party omits the key entirely so the
          // column defaults to null, matching the create-payload assertions in
          // booking-split.test.ts.
          ...(parentBookingId != null ? { parentBookingId } : {}),
          // ORGANISER_PAYS joins flag the booking so the joiner is never billed
          // and the organiser settles it. Omitted entirely otherwise so the
          // column defaults to false and the create-payload assertions in
          // booking-split.test.ts stay unchanged.
          ...(organiserSettled ? { organiserSettled: true } : {}),
          notes: notes || null,
          expectedArrivalTime: expectedArrivalTime || null,
          requestedRoomId: requestedRoomId || null,
          cancelIfGuestsBumped: cancelIfGuestsBumped ?? false,
          createdById: isOnBehalf ? sessionUserId : null,
          requiresAdminReview: review.requiresAdminReview,
          adminReviewReason: review.adminReviewReason,
          memberReviewJustification: review.memberReviewJustification,
          adminReviewStatus: review.adminReviewStatus,
          adminReviewNotes: review.adminReviewNotes,
          adminReviewedById: review.adminReviewedById,
          adminReviewedAt: review.adminReviewedAt,
          guests: { create: buildGuestCreateData(primaryGuests, price, checkIn, checkOut) },
        },
        include: { guests: true },
      });

      if (promoCodeRecord && promoShouldPersist) {
        await redeemPromoCode(
          tx,
          promoCodeRecord.id,
          newBooking.id,
          effectiveMemberId,
          discountCents,
          promoAdjustmentCents,
          promoFreeNightsUsed || undefined,
          promoEligibleGuestCount || undefined,
          promoAllocations,
          getPromoTargetBookingGuestIds(newBooking.guests, promoSelectedGuestIndexes),
        );
      }

      if (creditAppliedCents > 0) {
        await applyCreditToBooking(effectiveMemberId, creditAppliedCents, newBooking.id, tx);
      }

      // Zero-dollar (or fully credit-covered) PAYMENT_PENDING booking:
      // final-claim capacity, create $0 SUCCEEDED Payment, set PAID.
      // Skipped when the booking is held in AWAITING_REVIEW — payment
      // (including the zero-dollar auto-PAID path) must wait for admin.
      if (
        effectivePriceCents === 0 &&
        requestedStatus === BookingStatus.PAYMENT_PENDING &&
        !review.blockForReview
      ) {
        const finalCapacityCheck = await checkCapacityForGuestRanges(
          checkIn,
          checkOut,
          capacityGuestRanges,
          newBooking.id,
          tx
        );
        if (!finalCapacityCheck.available) {
          // Since #737/#738 a PENDING booking holds no capacity, so there is no
          // synchronous bump to fall back on: a $0 all-member booking that does
          // not fit against committed bookings is rejected with the
          // capacity-exceeded response, never bumped into a full lodge
          // (issue #738, carried over from R1).
          capacityFullNights = getCapacityFullNights(finalCapacityCheck.nightDetails);
          throw new Error("CAPACITY_EXCEEDED_SENTINEL");
        }

        isZeroDollarConfirmed = true;
        await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: 0,
            creditAppliedCents,
            status: PaymentStatus.SUCCEEDED,
          },
        });
        await tx.booking.update({
          where: { id: newBooking.id },
          data: { status: BookingStatus.PAID },
        });
        newBooking.status = BookingStatus.PAID;
      } else if (
        internetBankingPaymentSelected &&
        effectivePriceCents > 0
      ) {
        const reference = buildInternetBankingPaymentReference(newBooking.id);
        const payment = await tx.payment.create({
          data: {
            bookingId: newBooking.id,
            amountCents: effectivePriceCents,
            creditAppliedCents,
            source: PaymentSource.INTERNET_BANKING,
            reference,
            status: PaymentStatus.PENDING,
          },
        });

        await recordInternetBankingPaymentTransaction({
          paymentId: payment.id,
          amountCents: effectivePriceCents,
          status: PaymentStatus.PENDING,
          reference,
          reason: "internet_banking_booking_payment",
          store: tx,
        });
      }

      await reconcileBedAllocationsForBooking({
        bookingId: newBooking.id,
        db: tx,
      });

      // Split booking (#738): create the linked provisional non-member booking
      // in the same transaction. It is PENDING and holds no capacity (it does
      // not run the capacity check or take payment in R2 — confirmed/charged or
      // bumped at the hold window in R3). It carries no promo/credit; those stay
      // with the member booking that is charged up front.
      if (splitBooking) {
        const childGuestInputs = toGuestPricingInputs(nonMemberGuests);
        const childPrice = priceBookingGuests({
          checkIn,
          checkOut,
          guests: childGuestInputs,
          seasons: seasonData,
          groupDiscount,
        });
        const childHoldUntil = new Date(
          checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000
        );
        const childBooking = await tx.booking.create({
          data: {
            memberId: effectiveMemberId,
            checkIn,
            checkOut,
            status: BookingStatus.PENDING,
            totalPriceCents: childPrice.totalPriceCents,
            discountCents: 0,
            promoAdjustmentCents: 0,
            finalPriceCents: childPrice.totalPriceCents,
            hasNonMembers: true,
            nonMemberHoldUntil: childHoldUntil,
            parentBookingId: newBooking.id,
            notes: notes || null,
            expectedArrivalTime: expectedArrivalTime || null,
            requestedRoomId: requestedRoomId || null,
            cancelIfGuestsBumped: false,
            createdById: isOnBehalf ? sessionUserId : null,
            guests: {
              create: buildGuestCreateData(
                nonMemberGuests,
                childPrice,
                checkIn,
                checkOut
              ),
            },
          },
          include: { guests: true },
        });
        await reconcileBedAllocationsForBooking({
          bookingId: childBooking.id,
          db: tx,
        });
        splitChild = {
          id: childBooking.id,
          finalPriceCents: childBooking.finalPriceCents,
        };
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
      guestCount: primaryGuests.length,
      hasNonMembers: primaryHasNonMembers,
      finalPriceCents: booking.finalPriceCents,
      zeroDollarConfirmed: isZeroDollarConfirmed,
      paymentMethod,
      split: splitBooking,
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
        guestCount: primaryGuests.length,
        hasNonMembers: primaryHasNonMembers,
        finalPriceCents: booking.finalPriceCents,
        paymentMethod,
        split: splitBooking,
      },
    });
  }

  // Durable lifecycle events (issue #740): the booking was created, and the
  // split non-member child (if any) was created in the same transaction.
  await recordBookingEvent({
    bookingId: booking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: booking.finalPriceCents,
  });
  // `splitChild` is only assigned inside the transaction closure, which TS
  // control-flow narrows away in this outer scope; cast back to its type.
  const createdSplitChild = splitChild as
    | { id: string; finalPriceCents: number }
    | null;
  if (createdSplitChild) {
    await recordBookingEvent({
      bookingId: createdSplitChild.id,
      type: BookingEventType.CREATED,
      actorMemberId: sessionUserId,
      amountCents: createdSplitChild.finalPriceCents,
    });
  }
  // A fully credit-covered or genuinely free booking is paid up front at $0.
  if (isZeroDollarConfirmed) {
    await recordBookingEvent({
      bookingId: booking.id,
      type: BookingEventType.MEMBER_PAID,
      actorMemberId: sessionUserId,
      amountCents: 0,
    });
  }

  if (isZeroDollarConfirmed) {
    try {
      const fullBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: {
          member: true,
          guests: true,
          promoRedemption: {
            include: {
              promoCode: { include: { workPartyEvent: { select: { name: true } } } },
            },
          },
        },
      });
      if (fullBooking) {
        sendBookingConfirmedEmail(
          fullBooking.member.email,
          fullBooking.member.firstName,
          fullBooking.checkIn,
          fullBooking.checkOut,
          fullBooking.guests.length,
          fullBooking.finalPriceCents,
          fullBooking.promoRedemption?.promoCode
            ? {
                discountCents: fullBooking.discountCents,
                promoAdjustmentCents: fullBooking.promoAdjustmentCents,
                // Internal work-party promo codes are meaningless to
                // members; label the discount with the event name instead.
                promoCode:
                  fullBooking.promoRedemption.promoCode.workPartyEvent?.name ??
                  fullBooking.promoRedemption.promoCode.code,
              }
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

  if (
    paymentMethod === "internet_banking" &&
    booking.status === BookingStatus.PAYMENT_PENDING &&
    !isZeroDollarConfirmed
  ) {
    try {
      const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id, {
        createdByMemberId: sessionUserId,
      });
      if (queuedInvoice.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id },
        "Failed to queue Xero invoice for Internet Banking booking"
      );
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
      memberJustification: booking.memberReviewJustification,
    }).catch((err) => logger.error({ err }, "Failed to send admin new booking alert"));
  }

  return { type: "created", booking, bumpedBookingIds: [], isZeroDollarConfirmed };
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
    checkIn: inputCheckIn,
    checkOut: inputCheckOut,
    guests,
    notes,
    promoCodeStr,
    promoGuestIndexes,
    workPartyEventId,
    expectedArrivalTime,
    requestedRoomId,
    cancelIfGuestsBumped,
    groupDiscount,
    memberReviewJustification,
  } = input;
  // Auto-expand (issue #713): the persisted range covers every guest night,
  // never shrinking below the member's stated range.
  const { checkIn, checkOut } = resolveBookingDateEnvelope(
    guests,
    inputCheckIn,
    inputCheckOut
  );

  // Throws BookingReviewJustificationRequiredError if the rule trips on a
  // member-created booking with no justification supplied. WAITLISTED is
  // kept as the persisted status (waitlist doesn't hold capacity), but
  // adminReviewStatus = PENDING so the review queue and force-confirm path
  // know it needs a decision before it can progress.
  const review = resolveAdminReviewFields({
    guests,
    isOnBehalf,
    sessionUserId,
    memberReviewJustification,
  });

  const seasons = await prisma.season.findMany({
    where: { active: true, startDate: { lte: checkOut }, endDate: { gte: checkIn } },
    include: { rates: true },
  });
  const seasonData = toSeasonRateData(seasons);
  const guestInputs = toGuestPricingInputs(guests);
  const price = priceBookingGuests({ checkIn, checkOut, guests: guestInputs, seasons: seasonData, groupDiscount });

  let discountCents = 0;
  let promoAdjustmentCents = 0;
  let promoFreeNightsUsed = 0;
  let promoEligibleGuestCount = 0;
  let promoAllocations: PromoBeneficiaryAllocation[] = [];
  let promoSelectedGuestIndexes: number[] | undefined;
  let promoShouldPersist = false;
  let promoCodeRecord: ResolvedPromo["promoCodeRecord"] = null;

  const promoSource = await resolveEffectivePromoSource(prisma, {
    promoCodeStr,
    workPartyEventId,
    checkIn,
    checkOut,
  });
  if (promoSource) {
    const normalizedCode = promoSource.promoCodeStr.toUpperCase().trim();
    const promoCode = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: { assignments: { select: { memberId: true } } },
    });
    if (promoCode?.internal && !promoSource.allowInternal) {
      throw new BookingPromoError("Promo code not found");
    }
    const assignedMemberIds = promoCode?.assignments?.length
      ? promoCode.assignments.map((a) => a.memberId)
      : null;
    const guestNightRates = guests.map((guest, index) => ({
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: price.guests[index].perNightCents,
      firstNight: guest.stayStart ?? checkIn,
      nightDates: price.guests[index].nightDates,
    }));
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: effectiveMemberId,
        bookingCheckIn: checkIn,
        totalPriceCents: price.totalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      { db: prisma, selectedGuestIndexes: promoGuestIndexes }
    );
    if (application.error || !application.discount) {
      throw new BookingPromoError(application.error ?? "Promo code could not be applied");
    }
    const promoResult = application.discount;
    discountCents = promoResult.discountCents;
    promoAdjustmentCents = promoResult.priceAdjustmentCents;
    promoFreeNightsUsed = promoResult.freeNightsUsed;
    promoEligibleGuestCount = promoResult.eligibleGuestCount;
    promoAllocations = promoResult.allocations;
    promoSelectedGuestIndexes = application.selectedGuestIndexes;
    promoShouldPersist = shouldPersistPromoRedemption(promoResult);
    promoCodeRecord = promoCode;
  }

  const finalPriceCents = price.totalPriceCents + promoAdjustmentCents;
  const hasNonMembers = guests.some((g) => !g.isMember);

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
        promoAdjustmentCents,
        finalPriceCents,
        hasNonMembers,
        nonMemberHoldUntil: null,
        notes: notes || null,
        expectedArrivalTime: expectedArrivalTime || null,
        requestedRoomId: requestedRoomId || null,
        cancelIfGuestsBumped: cancelIfGuestsBumped ?? false,
        createdById: isOnBehalf ? sessionUserId : null,
        requiresAdminReview: review.requiresAdminReview,
        adminReviewReason: review.adminReviewReason,
        memberReviewJustification: review.memberReviewJustification,
        adminReviewStatus: review.adminReviewStatus,
        adminReviewNotes: review.adminReviewNotes,
        adminReviewedById: review.adminReviewedById,
        adminReviewedAt: review.adminReviewedAt,
        guests: { create: buildGuestCreateData(guests, price, checkIn, checkOut) },
      },
      include: { guests: true },
    });

    if (promoCodeRecord && promoShouldPersist) {
      await redeemPromoCode(
        tx,
        promoCodeRecord.id,
        createdBooking.id,
        effectiveMemberId,
        discountCents,
        promoAdjustmentCents,
        promoFreeNightsUsed || undefined,
        promoEligibleGuestCount || undefined,
        promoAllocations,
        getPromoTargetBookingGuestIds(createdBooking.guests, promoSelectedGuestIndexes),
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
      memberJustification: newBooking.memberReviewJustification,
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

  await recordBookingEvent({
    bookingId: newBooking.id,
    type: BookingEventType.CREATED,
    actorMemberId: sessionUserId,
    amountCents: newBooking.finalPriceCents,
  });

  return { booking: newBooking, position };
}
