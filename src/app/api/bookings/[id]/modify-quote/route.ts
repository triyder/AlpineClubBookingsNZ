import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { overCapacityNights } from "@/lib/over-capacity-confirmation";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import {
  getStayNights,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  applyMembershipTypeRatePolicyToGuests,
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { parseJsonRequestBody } from "@/lib/api-json";
import { ApiError } from "@/lib/api-error";
import {
  assertCheckInClearsXeroLockDate,
  assertDateEditClearsXeroLockDate,
  getXeroLockGuardErrorResponse,
} from "@/lib/xero-period-lock-guard";
import {
  validateAndCalculatePromoDiscount,
  validatePromoCodeFull,
} from "@/lib/promo";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import { nameField } from "@/lib/zod-helpers";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  calculateModificationSettlementOptions,
  lockedNightPricesForGuest,
  resolveGuestNameUpdates,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
  resolvePartnerSharedCapacity,
} from "@/lib/booking-modify";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { getSeasonYear } from "@/lib/utils";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import {
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import logger from "@/lib/logger";

const modifyQuoteSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      })
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      })
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      })
    )
    .optional(),
  promoCode: z.string().optional(),
  removePromoCode: z.boolean().optional(),
  // Admin-only date override (issue #1668). The preview mirrors apply exactly.
  adminOverride: z.boolean().optional(),
  pricingMode: z.enum(["shift", "recalculate"]).optional(),
  confirmOverCapacity: z.boolean().optional(),
  // Admin-only (#1746): mirror of the apply route's partner-sharer flags so
  // the preview reflects the #1745 reserved-slot outcome.
  partnerSharedGuests: z
    .array(
      z.object({
        memberId: z.string().min(1),
        partnerMemberId: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
});

const OVERRIDE_DATE_ONLY_QUOTE_FIELDS = [
  "addGuests",
  "removeGuestIds",
  "guestStayRanges",
  "guestUpdates",
  "promoCode",
  "removePromoCode",
  // #1746: partner-shared flags ride guest changes, never a date override.
  "partnerSharedGuests",
] as const;

type StayRangeInput = {
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: ReadonlyArray<string> | null;
};

type NormalizedAddGuest = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: ReadonlyArray<string> | null;
};

type NormalizedAddGuestWithRange = Omit<NormalizedAddGuest, "stayStart" | "stayEnd"> & {
  stayStart: Date;
  stayEnd: Date;
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

function hasStayRangeValue(value: string | null | undefined): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;
}

function hasStayRangeInput(input: StayRangeInput): boolean {
  return (
    hasStayRangeValue(input.stayStart) ||
    hasStayRangeValue(input.stayEnd) ||
    (input.nights != null && input.nights.length > 0)
  );
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
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
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so the quote preview mirrors the admin-on-behalf modify they will perform —
  // every isAdmin branch below (skip member-night authorization, locked-period,
  // unpaid-subscription, and minimum-stay checks) applies to them identically to
  // a Full Admin. Full Admin already resolves to ADMIN; member/read-only stay USER.
  const actorRole = bookingManagementAuthorizationRole(session.user);
  const isAdmin = actorRole === "ADMIN";

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // Per-night sets (issue #713): preserve unedited guests' gaps in the quote.
      guests: { include: { nights: { select: { stayDate: true, priceCents: true } } } },
      payment: true,
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
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!canModifyBookingStatusForRole(booking.status, actorRole)) {
    return NextResponse.json(
      { error: "This booking cannot be modified in its current status" },
      { status: 400 }
    );
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = modifyQuoteSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    addGuests,
    removeGuestIds,
    guestStayRanges,
    guestUpdates,
    promoCode: newPromoCode,
    removePromoCode,
    pricingMode,
    confirmOverCapacity,
  } = parsed.data;

  // Issue #1668: admin-only date override. Gate the flags, then compute the
  // edit policy WITH the override so its mode is "admin-override" and every
  // downstream guard (in-progress clamp, "NZ today locked", change-fee gate)
  // falls out on its own — the same code path the apply services take, so the
  // preview mirrors apply without a parallel branch.
  const overrideFlagsPresent =
    parsed.data.adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined;
  if (overrideFlagsPresent && !isAdmin) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  // #1746: partner-shared placement is admin-initiated by owner decision.
  if (parsed.data.partnerSharedGuests?.length && !isAdmin) {
    return NextResponse.json(
      { error: "Partner-shared placement is not available for this account" },
      { status: 403 },
    );
  }
  const partnerSharedGuests = isAdmin ? (parsed.data.partnerSharedGuests ?? []) : [];
  const adminOverride = isAdmin && Boolean(parsed.data.adminOverride);
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  if (
    !adminOverride &&
    (pricingMode !== undefined || confirmOverCapacity !== undefined)
  ) {
    return NextResponse.json(
      { error: "adminOverride is required for pricingMode/confirmOverCapacity" },
      { status: 400 },
    );
  }
  if (
    adminOverride &&
    OVERRIDE_DATE_ONLY_QUOTE_FIELDS.some((field) => {
      const value = parsed.data[field];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    })
  ) {
    return NextResponse.json(
      { error: "Admin override edits change dates only" },
      { status: 400 },
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adminOverride,
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
      { status: 400 }
    );
  }

  // Shift preview (issue #1668): a pure translation quote. Validate parity and
  // derive the missing bound identically to the apply path, translate the guest
  // ranges by the same day-delta, run the capacity check, and echo the stored
  // money with zero deltas so the UI's preview matches what apply will write.
  if (adminOverride && pricingMode === "shift") {
    // Quote-priced bookings are blocked here too (#1032): the shift apply path
    // refuses them (assertBookingNotQuotePriced), so the preview must not show
    // a clean $0 quote it cannot deliver.
    if (await isQuotePricedBooking(prisma, bookingId)) {
      return NextResponse.json(
        { error: QUOTE_PRICED_EDIT_BLOCK_MESSAGE },
        { status: 400 },
      );
    }
    return buildShiftPreviewResponse({
      booking,
      bookingId,
      actorMemberId: session.user.id,
      actorRole,
      newCheckInStr,
      newCheckOutStr,
    });
  }
  // Xero lock-date guard: the preview rejects a locked-period check-in with
  // the same 409/503 the apply services throw, instead of showing a quote
  // that apply cannot deliver. The scopes mirror apply exactly (see
  // xero-period-lock-guard): the recalculate OVERRIDE keeps the deliberately
  // conservative always-check (#1697, re-affirmed on #1718; only recalculate
  // reaches here — shift returned above and stays unguarded, it writes no
  // Xero documents), while an ORDINARY edit gets the narrow guard (#1729)
  // that fires only when apply would queue the check-in-dated invoice update,
  // with member-appropriate error text for non-admin actors. Identity-only
  // previews carry no date fields and are never guarded.
  try {
    if (adminOverride) {
      await assertCheckInClearsXeroLockDate(
        newCheckInStr ? parseDateOnly(newCheckInStr) : booking.checkIn,
      );
    } else {
      await assertDateEditClearsXeroLockDate(
        booking,
        { checkIn: newCheckInStr, checkOut: newCheckOutStr },
        { audience: isAdmin ? "admin" : "member" },
      );
    }
  } catch (error) {
    const xeroLockGuardResponse = getXeroLockGuardErrorResponse(error);
    if (xeroLockGuardResponse) {
      return NextResponse.json(xeroLockGuardResponse.body, {
        status: xeroLockGuardResponse.status,
      });
    }
    throw error;
  }
  // Quote-priced bookings are blocked at preview time too (#1032) — except
  // for identity-only requests (#1099), which never touch the pricing engine
  // and therefore cannot disturb the negotiated basis.
  const requestedStructuralChange = Boolean(
    newCheckInStr ||
      newCheckOutStr ||
      addGuests?.length ||
      removeGuestIds?.length ||
      guestStayRanges?.length ||
      newPromoCode ||
      removePromoCode,
  );
  const requestIsIdentityOnly =
    !requestedStructuralChange && Boolean(guestUpdates?.length);
  const quotePriced = await isQuotePricedBooking(prisma, bookingId);
  if (!requestIsIdentityOnly && quotePriced) {
    return NextResponse.json(
      { error: QUOTE_PRICED_EDIT_BLOCK_MESSAGE },
      { status: 400 },
    );
  }

  let normalizedAddGuests: NormalizedAddGuest[] | undefined = addGuests;
  let guestNameUpdates: ReturnType<typeof resolveGuestNameUpdates> = [];

  try {
    guestNameUpdates = resolveGuestNameUpdates({
      booking,
      input: { guestUpdates, removeGuestIds },
      // Quoted bookings rename placeholder students even after payment.
      allowWhenFullyPaid: quotePriced,
      // Preview mirrors the server gate (#1386): identity-only typo fixes on a
      // fully-paid booking are allowed; swaps are rejected the same way.
      allowTypoFixWhenFullyPaid: requestIsIdentityOnly,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // Identity-only preview (#1099): a name fix never reprices, so the quote is
  // the stored state with zero deltas — no pricing engine, no capacity check,
  // safe for quoted and legacy bookings alike.
  if (requestIsIdentityOnly) {
    return NextResponse.json({
      newTotalPriceCents: booking.totalPriceCents,
      newDiscountCents: booking.discountCents,
      newPromoAdjustmentCents: booking.promoAdjustmentCents,
      newFinalPriceCents: booking.finalPriceCents,
      priceDiffCents: 0,
      changeFeeCents: 0,
      netChargeCents: 0,
      settlementOptions: null,
      capacityAvailable: true,
      minimumStayValid: true,
      minimumStayViolations: [],
      promoStillValid: true,
      promoValidation: null,
      itemizedChanges:
        guestNameUpdates.length > 0
          ? [
              {
                label:
                  guestNameUpdates.length === 1
                    ? "Guest name update"
                    : "Guest name updates",
                amountCents: 0,
              },
            ]
          : [],
    });
  }

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      booking.memberId,
      (addGuests ?? []).map((guest) => guest.memberId),
      { skipAuthorization: isAdmin }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAdmin ? booking.memberId : null,
      }
    );
    normalizedAddGuests = addGuests
      ? normalizeBookingGuestInputs(addGuests, linkedMembers).map((guest, index) => ({
          ...guest,
          stayStart: addGuests[index]?.stayStart ?? null,
          stayEnd: addGuests[index]?.stayEnd ?? null,
          nights: addGuests[index]?.nights ?? null,
        }))
      : undefined;
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    throw error;
  }

  // Determine new dates
  const requestedCheckIn = newCheckInStr ? parseDateOnly(newCheckInStr) : booking.checkIn;
  const requestedCheckOut = newCheckOutStr ? parseDateOnly(newCheckOutStr) : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    return NextResponse.json(
      { error: "Invalid booking dates" },
      { status: 400 }
    );
  }

  const hasRangeInputs =
    (guestStayRanges?.some(hasStayRangeInput) ?? false) ||
    (normalizedAddGuests?.some(hasStayRangeInput) ?? false);
  const existingRangeInputs = new Map(
    (guestStayRanges ?? []).map((range) => [range.guestId, range])
  );
  let finalRequestedCheckIn = requestedCheckIn;
  let finalRequestedCheckOut = requestedCheckOut;

  if (hasRangeInputs) {
    try {
      const removeSet = new Set(removeGuestIds ?? []);
      const envelope = {
        checkIn: requestedCheckIn < booking.checkIn ? requestedCheckIn : booking.checkIn,
        checkOut: requestedCheckOut > booking.checkOut ? requestedCheckOut : booking.checkOut,
      };
      const proposedRanges: Array<{ stayStart: Date; stayEnd: Date }> = [];

      for (const guest of booking.guests) {
        if (removeSet.has(guest.id)) {
          continue;
        }
        const rangeInput = existingRangeInputs.get(guest.id);
        if (rangeInput && hasStayRangeInput(rangeInput)) {
          proposedRanges.push(
            normalizeGuestStayRange(rangeInput, envelope, proposedRanges.length)
          );
        } else {
          proposedRanges.push({
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
          });
        }
      }

      for (const guest of normalizedAddGuests ?? []) {
        if (hasStayRangeInput(guest)) {
          proposedRanges.push(
            normalizeGuestStayRange(guest, envelope, proposedRanges.length)
          );
        } else {
          proposedRanges.push({
            stayStart: normalizeDateOnlyForTimeZone(requestedCheckIn),
            stayEnd: normalizeDateOnlyForTimeZone(requestedCheckOut),
          });
        }
      }

      if (proposedRanges.length > 0) {
        finalRequestedCheckIn = minDate(proposedRanges.map((range) => range.stayStart));
        finalRequestedCheckOut = maxDate(proposedRanges.map((range) => range.stayEnd));
      }
    } catch (error) {
      if (error instanceof BookingGuestStayRangeValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const editableFrom = editPolicy.editableFrom;

  if (isInProgressEdit) {
    if (
      formatDateOnly(normalizeDateOnlyForTimeZone(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      return NextResponse.json(
        { error: "Check-in cannot be changed for an in-progress booking" },
        { status: 400 }
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(finalRequestedCheckOut) < editableFrom) {
      return NextResponse.json(
        { error: "NZ today and earlier are locked for self-service changes" },
        { status: 400 }
      );
    }
    if (newPromoCode || removePromoCode) {
      return NextResponse.json(
        { error: "Promo code changes are not available for in-progress bookings" },
        { status: 400 }
      );
    }
  } else if (
    !isAdmin &&
    normalizeDateOnlyForTimeZone(finalRequestedCheckIn) <= editPolicy.today
  ) {
    return NextResponse.json(
      { error: "NZ today and earlier are locked for self-service changes" },
      { status: 400 }
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;
  const skipBookingLifecycleRules =
    isAdmin &&
    !usesActiveBookingEditLifecycle(booking.status);

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }
  const targetDatesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  // Determine new guest list
  const removeSet = new Set(removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    return NextResponse.json(
      { error: "Booking must have at least one guest" },
      { status: 400 }
    );
  }

  let proposedRemainingGuests: Array<{
    guest: (typeof remainingGuests)[number];
    stayStart: Date;
    stayEnd: Date;
    nights?: Date[];
  }>;
  let normalizedAddGuestsWithRanges: NormalizedAddGuestWithRange[] | undefined;
  try {
    proposedRemainingGuests = remainingGuests.map((guest, index) => {
      const existingNights =
        guest.nights && guest.nights.length > 0
          ? guest.nights.map((night) => night.stayDate)
          : undefined;
      if (!hasRangeInputs) {
        return targetDatesChanged
          ? { guest, stayStart: newCheckIn, stayEnd: newCheckOut }
          : {
              guest,
              stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
              stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
              nights: existingNights,
            };
      }

      const rangeInput = existingRangeInputs.get(guest.id);
      const normalizedRange =
        rangeInput && hasStayRangeInput(rangeInput)
          ? normalizeGuestStayRange(rangeInput, { checkIn: newCheckIn, checkOut: newCheckOut }, index)
          : {
              stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
              stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
              nights: existingNights,
            };

      return { guest, ...normalizedRange };
    });
    normalizedAddGuestsWithRanges = normalizedAddGuests
      ? normalizeGuestStayRanges(normalizedAddGuests, {
          checkIn: newCheckIn,
          checkOut: newCheckOut,
        })
      : undefined;
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const guestsForPricing = [
    ...proposedRemainingGuests.map((entry) => ({
      bookingGuestId: entry.guest.id,
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights,
      // Preview with the same locked booked-night prices the mutating
      // endpoints charge (#1036).
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
  const seasonYear = getSeasonYear(newCheckIn);

  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const lodgeCapacity = await getLodgeCapacity(bookingLodgeId);
  if (totalGuestCount > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${lodgeCapacity} guests` },
      { status: 400 }
    );
  }

  const memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
    actorMemberId: session.user.id,
    actorRole,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: guestsForPricing,
    excludeBookingId: booking.id,
  });
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  try {
    await assertMembershipTypeBookingAllowed(prisma, {
      ownerMemberId: booking.memberId,
      guests: guestsForPricing,
      seasonYear,
    });
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(error),
        { status: error.status },
      );
    }
    throw error;
  }

  if (!isAdmin) {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(prisma, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
      guests: normalizedAddGuests ?? [],
    });

    if (unpaidMemberGuests.length > 0) {
      return NextResponse.json(
        {
          error: `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
          code: "GUEST_SUBSCRIPTION_REQUIRED",
          unpaidMembers: unpaidMemberGuests,
        },
        { status: 403 }
      );
    }
  }

  // Minimum stay policy validation (skip for admins)
  let minimumStayViolations: { policyName: string; triggerDay: string; minimumNights: number; actualNights: number }[] = [];
  if (!isAdmin && !isInProgressEdit) {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(newCheckIn, newCheckOut, bookingLodgeId);
    minimumStayViolations = stayResult.violations;
  }

  // Load seasons for pricing
  const seasons = await prisma.season.findMany({
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

  // The preview must quote what the mutating paths will charge (#1095): the
  // group discount applies to newly priced nights on every pricing pass below.
  const groupDiscount = toGroupDiscountConfig(
    await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
  );

  const policyAdjustedGuestsForPricing = await applyMembershipTypeRatePolicyToGuests(prisma, {
    seasonYear,
    guests: guestsForPricing,
  });
  const policyAdjustedAddGuests = normalizedAddGuestsWithRanges
    ? await applyMembershipTypeRatePolicyToGuests(prisma, {
        seasonYear,
        guests: normalizedAddGuestsWithRanges,
      })
    : undefined;
  const policyAdjustedExistingGuests = await applyMembershipTypeRatePolicyToGuests(prisma, {
    seasonYear,
    guests: booking.guests.map((guest) => ({
      ...guest,
      ageTier: guest.ageTier as AgeTier,
    })),
  });

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  try {
    inProgressPlan =
      isInProgressEdit && editableFrom
        ? buildInProgressGuestRangePlan({
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
        })
        : null;
  } catch (error) {
    logger.error({ err: error, bookingId }, "Failed to price booking modification quote");
    return NextResponse.json(
      { error: "Unable to price the requested future-night changes" },
      { status: 400 }
    );
  }

  // Capacity check (exclude current booking)
  // #1746: with admin-flagged partner-sharers the preview runs the same
  // reserved-slot split the apply service uses (resolvePartnerSharedCapacity),
  // reporting the outcome + reason instead of the ordinary capacity verdict.
  let partnerSharedReason: string | null = null;
  let capacity: Awaited<ReturnType<typeof checkCapacityForGuestRanges>>;
  if (skipBookingLifecycleRules) {
    capacity = { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  } else if (partnerSharedGuests.length > 0) {
    let shared;
    try {
      shared = await resolvePartnerSharedCapacity({
        lodgeId: bookingLodgeId,
        rangeStart: inProgressPlan && editableFrom ? editableFrom : newCheckIn,
        rangeEnd: newCheckOut,
        proposedRanges:
          inProgressPlan && editableFrom
            ? inProgressPlan.capacityGuestRanges
            : policyAdjustedGuestsForPricing,
        partnerSharedGuests,
        excludeBookingId: bookingId,
      });
    } catch (error) {
      // Mirror the apply route's status for splitter input errors (an
      // unmatched or duplicated sharer flag) — a 400-class payload must not
      // 500 the preview while 400ing the apply.
      if (error instanceof ApiError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
    partnerSharedReason = shared.available ? null : shared.reason;
    capacity = {
      available: shared.available,
      minAvailable: shared.minAvailable,
      nightDetails: shared.nightDetails,
    };
  } else {
    capacity =
      inProgressPlan && editableFrom
        ? await checkCapacityForGuestRanges(
            bookingLodgeId,
            editableFrom,
            newCheckOut,
            inProgressPlan.capacityGuestRanges,
            bookingId
          )
        : await checkCapacityForGuestRanges(
            bookingLodgeId,
            newCheckIn,
            newCheckOut,
            policyAdjustedGuestsForPricing,
            bookingId
          );
  }

  // Calculate new total price
  let newTotalPriceCents: number;
  let priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[]; nightDates: Date[] }>;
  } | null = null;
  try {
    if (inProgressPlan) {
      newTotalPriceCents = inProgressPlan.newTotalPriceCents;
    } else {
      priceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: policyAdjustedGuestsForPricing,
        seasons: seasonRateData,
        groupDiscount,
        seasonYear,
      });
      newTotalPriceCents = priceBreakdown.totalPriceCents;
    }
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(error),
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "No season rate found for the requested dates" },
      { status: 400 }
    );
  }

  // --- Build itemized changes ---
  const itemizedChanges: Array<{ label: string; amountCents: number }> = [];
  if (guestNameUpdates.length > 0) {
    itemizedChanges.push({
      label:
        guestNameUpdates.length === 1
          ? "Guest name update"
          : "Guest name updates",
      amountCents: 0,
    });
  }

  const oldNights = getStayNights(booking.checkIn, booking.checkOut).length;
  const newNights = getStayNights(newCheckIn, newCheckOut).length;
  const datesChanged = targetDatesChanged;
  const guestRangesChanged = proposedRemainingGuests.some((entry) => {
    const currentStayStart = normalizeDateOnlyForTimeZone(
      entry.guest.stayStart ?? booking.checkIn
    );
    const currentStayEnd = normalizeDateOnlyForTimeZone(
      entry.guest.stayEnd ?? booking.checkOut
    );
    return (
      currentStayStart.getTime() !== entry.stayStart.getTime() ||
      currentStayEnd.getTime() !== entry.stayEnd.getTime()
    );
  });

  // 1. Date change cost: price remaining guests at new dates vs old dates
  if (inProgressPlan) {
    if (inProgressPlan.futureExistingDeltaCents !== 0) {
      itemizedChanges.push({
        label:
          newCheckOut.getTime() !== new Date(booking.checkOut).getTime()
            ? "Future-night date change"
            : "Future-night guest range change",
        amountCents: inProgressPlan.futureExistingDeltaCents,
      });
    }
  } else if ((datesChanged || guestRangesChanged) && remainingGuests.length > 0) {
    const oldRemainingForPricing = remainingGuests.map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: normalizeDateOnlyForTimeZone(g.stayStart ?? booking.checkIn),
      stayEnd: normalizeDateOnlyForTimeZone(g.stayEnd ?? booking.checkOut),
    }));
    const newRemainingForPricing = proposedRemainingGuests.map((entry) => ({
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
    }));

    try {
      const oldPriceForRemaining = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: oldRemainingForPricing,
        seasons: seasonRateData,
        groupDiscount,
      });
      const newPriceForRemaining = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
        ownerMemberId: booking.memberId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        guests: newRemainingForPricing,
        seasons: seasonRateData,
        groupDiscount,
        seasonYear,
      });
      const dateChangeCost =
        newPriceForRemaining.totalPriceCents -
        oldPriceForRemaining.totalPriceCents;

      if (dateChangeCost !== 0) {
        const nightLabel =
          oldNights !== newNights
            ? `Date change: ${oldNights} night${oldNights !== 1 ? "s" : ""} → ${newNights} night${newNights !== 1 ? "s" : ""}`
            : guestRangesChanged
              ? "Guest stay range change"
            : "Date change (rate difference)";
        itemizedChanges.push({ label: nightLabel, amountCents: dateChangeCost });
      }
    } catch {
      // If pricing fails for old dates (unlikely), skip itemization
    }
  }

  // 2. Change fee
  let changeFeeCents = 0;
  const checkInChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

  if (!skipBookingLifecycleRules && checkInChanged && !isInProgressEdit) {
    const now = new Date();
    const policy = await loadCancellationPolicy(booking.checkIn, bookingLodgeId);
    const feeResult = calculateChangeFee({
      daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
      daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
      originalFinalPriceCents: booking.finalPriceCents,
      policyRules: policy,
    });
    changeFeeCents = feeResult.feeCents;

    if (changeFeeCents > 0) {
      itemizedChanges.push({
        label: "Late-notice change fee",
        amountCents: changeFeeCents,
      });
    }
  }

  // 3. Per-added-guest costs
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedAddedGuests) {
      const guest = entry.guest;
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: entry.priceCents,
      });
    }
  } else if (normalizedAddGuestsWithRanges && normalizedAddGuestsWithRanges.length > 0) {
    for (const guest of normalizedAddGuestsWithRanges) {
      try {
        const guestPrice = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
          ownerMemberId: booking.memberId,
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          guests: [
            {
              ageTier: guest.ageTier,
              isMember: guest.isMember,
              memberId: guest.memberId ?? null,
              stayStart: guest.stayStart,
              stayEnd: guest.stayEnd,
            },
          ],
          seasons: seasonRateData,
          groupDiscount,
          seasonYear,
        });
        const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
        const memberLabel = guest.isMember ? "Member" : "Non-member";
        itemizedChanges.push({
          label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
          amountCents: guestPrice.totalPriceCents,
        });
      } catch {
        // skip itemization if pricing fails
      }
    }
  }

  // 4. Per-removed-guest credits (use their stored priceCents)
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedExistingGuests.filter(
      (guest) => guest.removedFromFuture
    )) {
      const tierLabel = entry.guest.ageTier.charAt(0) + entry.guest.ageTier.slice(1).toLowerCase();
      const memberLabel = entry.guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed from future nights: ${entry.guest.firstName} ${entry.guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -entry.oldFuturePriceCents,
      });
    }
  } else {
    for (const guest of removedGuests) {
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -guest.priceCents,
      });
    }
  }

  // 5. Promo code handling
  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoStillValid = true;
  let promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null = null;

  // Helper: get per-night rates per guest for promo calculation
  function getGuestNightRates() {
    return guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown?.guests[index]?.perNightCents ?? [],
      nightDates: priceBreakdown?.guests[index]?.nightDates ?? [],
      // Dates the positional rates so internal work-party promos restrict
      // the discount to the event's night window.
      firstNight: guest.stayStart ?? newCheckIn,
    }));
  }

  if (inProgressPlan) {
    newDiscountCents = inProgressPlan.newDiscountCents;
    newPromoAdjustmentCents = inProgressPlan.newPromoAdjustmentCents;
  } else if (removePromoCode) {
    // User wants to remove existing promo (for reuse later)
    newDiscountCents = 0;
    newPromoAdjustmentCents = 0;
    promoValidation = null;
  } else if (newPromoCode) {
    // User wants to apply a new promo code
    const validation = await validatePromoCodeFull(newPromoCode, {
      totalPriceCents: newTotalPriceCents,
      memberId: booking.memberId,
      guests: getGuestNightRates(),
    }, bookingId, bookingLodgeId);

    if (validation.valid) {
      newDiscountCents = validation.discountCents ?? 0;
      newPromoAdjustmentCents = validation.promoAdjustmentCents ?? 0;
      promoValidation = {
        valid: true,
        code: validation.promoCode?.code,
        discountCents: validation.discountCents ?? 0,
        promoAdjustmentCents: validation.promoAdjustmentCents ?? 0,
      };
    } else {
      promoValidation = {
        valid: false,
        error: validation.error,
      };
      // Invalid new promo — discount stays 0, don't fall back to old promo
    }
  } else if (booking.promoRedemption?.promoCode) {
    // Keep existing promo, recalculate with new price
    const promo = booking.promoRedemption.promoCode;
    const guestNightRates = getGuestNightRates();
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
      { excludeBookingId: bookingId, db: prisma, selectedGuestIndexes, lodgeId: bookingLodgeId },
    );

    if (application.error || !application.discount) {
      promoStillValid = false;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
    }
  }

  // Add promo line item
  if (newPromoAdjustmentCents !== 0) {
    const promoLabel = newPromoCode
      ? `Promo '${newPromoCode.toUpperCase()}'`
      : booking.promoRedemption?.promoCode
        ? `Promo '${booking.promoRedemption.promoCode.code}'`
        : "Promo discount";
    itemizedChanges.push({
      label: promoLabel,
      amountCents: newPromoAdjustmentCents,
    });
  }

  // Show removed promo as the inverse of its previous signed adjustment.
  if (removePromoCode && booking.promoAdjustmentCents !== 0) {
    itemizedChanges.push({
      label: `Removed promo '${booking.promoRedemption?.promoCode?.code || "adjustment"}'`,
      amountCents: -booking.promoAdjustmentCents,
    });
  }

  const newFinalPriceCents = inProgressPlan
    ? inProgressPlan.newFinalPriceCents
    : newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = inProgressPlan
    ? inProgressPlan.priceDiffCents
    : newFinalPriceCents - booking.finalPriceCents;
  const netChargeCents = priceDiffCents + changeFeeCents;
  const settlementOptions = await calculateModificationSettlementOptions({
    booking,
    netChargeCents,
  });

  return NextResponse.json({
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    changeFeeCents,
    netChargeCents,
    settlementOptions,
    capacityAvailable: capacity.available,
    minimumStayValid: minimumStayViolations.length === 0,
    minimumStayViolations,
    promoStillValid,
    promoValidation,
    itemizedChanges,
    // #1746: why the partner-shared admission rejected — the UI shows this
    // verbatim; a partner-shared preview never offers the #1668 overbook
    // confirm (leave sharers unflagged to overbook the blunt way).
    ...(partnerSharedReason !== null ? { partnerSharedReason } : {}),
    // Issue #1668: under an admin override an over-capacity target does not hard
    // block — the UI keys its explicit confirm control off this flag.
    ...(adminOverride && !capacity.available && partnerSharedGuests.length === 0
      ? { overCapacityConfirmRequired: true }
      : {}),
    ...(capacity.available
      ? {}
      : {
          nightDetails: capacity.nightDetails.map((n) => ({
            date: n.date.toISOString().split("T")[0],
            availableBeds: n.availableBeds,
          })),
        }),
  });
}

/**
 * Shift-mode admin override preview (issue #1668): a pure-translation quote that
 * must match {@link adminShiftBookingDates} exactly for the same input. Every
 * money field echoes the stored booking; the only thing that can vary is
 * whether the shifted nights are over capacity, which the UI surfaces as an
 * explicit confirm rather than a hard error.
 */
async function buildShiftPreviewResponse({
  booking,
  bookingId,
  actorMemberId,
  actorRole,
  newCheckInStr,
  newCheckOutStr,
}: {
  booking: {
    status: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string | null;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: Array<{
      memberId?: string | null;
      stayStart: Date;
      stayEnd: Date;
      nights: Array<{ stayDate: Date }>;
    }>;
  };
  bookingId: string;
  actorMemberId: string;
  actorRole: "ADMIN" | "USER";
  newCheckInStr?: string;
  newCheckOutStr?: string;
}): Promise<NextResponse> {
  const oldCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const oldCheckOut = normalizeDateOnlyForTimeZone(booking.checkOut);
  const originalNightCount = eachDateOnlyInRange(oldCheckIn, oldCheckOut).length;

  const providedCheckIn = newCheckInStr ? parseDateOnly(newCheckInStr) : null;
  const providedCheckOut = newCheckOutStr ? parseDateOnly(newCheckOutStr) : null;
  if (
    (providedCheckIn && Number.isNaN(providedCheckIn.getTime())) ||
    (providedCheckOut && Number.isNaN(providedCheckOut.getTime()))
  ) {
    return NextResponse.json({ error: "Invalid booking dates" }, { status: 400 });
  }

  let newCheckIn: Date;
  let newCheckOut: Date;
  if (providedCheckIn && providedCheckOut) {
    newCheckIn = providedCheckIn;
    newCheckOut = providedCheckOut;
  } else if (providedCheckIn) {
    newCheckIn = providedCheckIn;
    newCheckOut = addDaysDateOnly(providedCheckIn, originalNightCount);
  } else if (providedCheckOut) {
    newCheckOut = providedCheckOut;
    newCheckIn = addDaysDateOnly(providedCheckOut, -originalNightCount);
  } else {
    return NextResponse.json(
      { error: "Provide a new check-in or check-out date" },
      { status: 400 },
    );
  }

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 },
    );
  }
  const newNightCount = eachDateOnlyInRange(newCheckIn, newCheckOut).length;
  if (newNightCount !== originalNightCount) {
    return NextResponse.json(
      {
        error:
          'Shift dates only moves the stay without changing its length — use "Recalculate price" to change the number of nights',
      },
      { status: 400 },
    );
  }

  // Whole-day delta between two UTC-midnight date-only values (DST-safe).
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round(
    (newCheckIn.getTime() - oldCheckIn.getTime()) / MS_PER_DAY,
  );

  const translatedRanges = booking.guests.map((guest) => ({
    memberId: guest.memberId ?? null,
    stayStart: addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayStart),
      deltaDays,
    ),
    stayEnd: addDaysDateOnly(
      normalizeDateOnlyForTimeZone(guest.stayEnd),
      deltaDays,
    ),
    nights: guest.nights.map((night) =>
      addDaysDateOnly(normalizeDateOnlyForTimeZone(night.stayDate), deltaDays),
    ),
  }));

  // Member-night conflicts hard-block the shift the same way apply does, so the
  // preview never shows a clean $0 quote for a move that would 409 on save.
  const memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
    actorMemberId,
    actorRole,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: translatedRanges,
    excludeBookingId: bookingId,
  });
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  // Non-lifecycle statuses hold no capacity, so a shift cannot overbook — skip
  // the check exactly like adminShiftBookingDates does so preview matches apply.
  const capacity = usesActiveBookingEditLifecycle(booking.status)
    ? await checkCapacityForGuestRanges(
        bookingLodgeId,
        newCheckIn,
        newCheckOut,
        translatedRanges,
        bookingId,
      )
    : { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };

  return NextResponse.json({
    newTotalPriceCents: booking.totalPriceCents,
    newDiscountCents: booking.discountCents,
    newPromoAdjustmentCents: booking.promoAdjustmentCents,
    newFinalPriceCents: booking.finalPriceCents,
    priceDiffCents: 0,
    changeFeeCents: 0,
    netChargeCents: 0,
    settlementOptions: null,
    capacityAvailable: capacity.available,
    minimumStayValid: true,
    minimumStayViolations: [],
    promoStillValid: true,
    promoValidation: null,
    itemizedChanges: [
      {
        label: `Dates shifted by ${Math.abs(deltaDays)} night(s) — price unchanged`,
        amountCents: 0,
      },
    ],
    ...(capacity.available
      ? {}
      : {
          overCapacityConfirmRequired: true,
          nightDetails: overCapacityNights(capacity),
        }),
  });
}
