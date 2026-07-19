// Split out of src/lib/booking-modify.ts (issue #1138): edit-eligibility
// validation and the shared loaded-booking types for the modification
// boundary. Code moved verbatim; import via the "@/lib/booking-modify" barrel.

import {
  BookingStatus,
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
  getBookingEditPolicy,
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";

export type BatchModifyInput = {
  checkIn?: string;
  checkOut?: string;
  addGuests?: Array<{
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId?: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    // Explicit included nights for a non-contiguous stay (issue #713).
    nights?: ReadonlyArray<string> | null;
  }>;
  removeGuestIds?: string[];
  guestStayRanges?: Array<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    // Explicit included nights for a non-contiguous stay (issue #713).
    nights?: ReadonlyArray<string> | null;
  }>;
  guestUpdates?: Array<{
    guestId: string;
    firstName: string;
    lastName: string;
  }>;
  promoCode?: string;
  promoGuestIndexes?: number[];
  removePromoCode?: boolean;
  memberReviewJustification?: string;
  settlementMethod?: BookingModificationSettlementMethod;
  // Admin-only date override (issue #1668). Only honoured for role === "ADMIN";
  // the callers enforce the date-only contract (no guest/promo inputs) and
  // require pricingMode when adminOverride is set.
  adminOverride?: boolean;
  pricingMode?: "shift" | "recalculate";
  confirmOverCapacity?: boolean;
  // Owner decision (#1668 review): the admin chooses per override edit whether
  // the member receives the change-notification email. Absent = notify.
  notifyMember?: boolean;
  // Admin-only (#1746): flags a proposed member guest as the second occupant
  // of a shared double with their CONFIRMED partner, routing capacity through
  // the #1745 reserved-slot admission check. Rejected for non-admin actors.
  partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
};

export type BookingModificationSettlementMethod = "card" | "credit";

type StayRangeInput = {
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: ReadonlyArray<string | Date> | null;
};

function hasStayRangeValue(value: string | null | undefined): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;
}

export function hasStayRangeInput(input: StayRangeInput): boolean {
  return (
    hasStayRangeValue(input.stayStart) ||
    hasStayRangeValue(input.stayEnd) ||
    (input.nights != null && input.nights.length > 0)
  );
}

export function hasGuestStayRangeInputs(input: BatchModifyInput): boolean {
  return (
    (input.guestStayRanges?.some(hasStayRangeInput) ?? false) ||
    (input.addGuests?.some(hasStayRangeInput) ?? false)
  );
}

export function normalizeRangeOrApiError(
  input: {
    stayStart?: string | Date | null;
    stayEnd?: string | Date | null;
    nights?: ReadonlyArray<string | Date> | null;
  },
  booking: { checkIn: Date; checkOut: Date },
  index: number
) {
  try {
    return normalizeGuestStayRange(input, booking, index);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

export function getGuestStayRangeInputMap(input: BatchModifyInput) {
  return new Map(
    (input.guestStayRanges ?? []).map((range) => [range.guestId, range])
  );
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

export type LoadedPromoRedemption = PromoRedemption & {
  promoCode: PromoCode & {
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

export type LoadedBookingForModify = Booking & {
  // Guests carry their explicit night set (issue #713) so an edit preserves the
  // gaps of guests that are not being changed and re-syncs only edited guests.
  guests: Array<
    BookingGuest & { nights?: { stayDate: Date; priceCents?: number }[] }
  >;
  payment: Payment | null;
  member: Member;
  promoRedemption: LoadedPromoRedemption | null;
};

type BookingGuestNameEditPayment = Pick<
  Payment,
  "status" | "amountCents" | "additionalAmountCents" | "additionalPaymentStatus"
> | null;

const FULLY_PAID_BOOKING_STATUSES = new Set<BookingStatus | string>([
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

export function hasOutstandingAdditionalPayment(
  payment: BookingGuestNameEditPayment,
) {
  return Boolean(
    payment &&
      payment.additionalAmountCents > 0 &&
      payment.additionalPaymentStatus !== "SUCCEEDED",
  );
}

export function isBookingFullyPaidForGuestNameEdits(booking: {
  status: BookingStatus | string;
  finalPriceCents: number;
  payment: BookingGuestNameEditPayment;
}) {
  if (hasOutstandingAdditionalPayment(booking.payment)) {
    return false;
  }

  if (hasCapturedPayment(booking.payment)) {
    return true;
  }

  return (
    booking.finalPriceCents <= 0 &&
    FULLY_PAID_BOOKING_STATUSES.has(booking.status)
  );
}

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
  // Issue #1668: only an admin may drive the override; a member request that
  // somehow carried the flag falls through to the normal date-window policy.
  const effectiveAdminOverride = Boolean(input.adminOverride) && role === "ADMIN";
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adminOverride: effectiveAdminOverride,
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

  let finalRequestedCheckIn = requestedCheckIn;
  let finalRequestedCheckOut = requestedCheckOut;
  if (hasGuestStayRangeInputs(input)) {
    const removeSet = new Set(input.removeGuestIds ?? []);
    const existingRangeInputs = getGuestStayRangeInputMap(input);
    const proposedRanges: Array<{ stayStart: Date; stayEnd: Date }> = [];
    const envelope = {
      checkIn: requestedCheckIn < booking.checkIn ? requestedCheckIn : booking.checkIn,
      checkOut: requestedCheckOut > booking.checkOut ? requestedCheckOut : booking.checkOut,
    };

    for (const guest of booking.guests) {
      if (removeSet.has(guest.id)) {
        continue;
      }
      const rangeInput = existingRangeInputs.get(guest.id);
      if (rangeInput && hasStayRangeInput(rangeInput)) {
        proposedRanges.push(
          normalizeRangeOrApiError(rangeInput, envelope, proposedRanges.length)
        );
      } else {
        proposedRanges.push({
          stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
          stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
        });
      }
    }

    for (const addGuest of input.addGuests ?? []) {
      if (hasStayRangeInput(addGuest)) {
        proposedRanges.push(
          normalizeRangeOrApiError(addGuest, envelope, proposedRanges.length)
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
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const editableFrom = editPolicy.editableFrom;
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);

  if (isInProgressEdit) {
    if (
      formatDateOnly(normalizeDateOnlyForTimeZone(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      throw new ApiError(
        "Check-in cannot be changed for an in-progress booking",
        400,
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(finalRequestedCheckOut) < editableFrom) {
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
    normalizeDateOnlyForTimeZone(finalRequestedCheckIn) <= editPolicy.today
  ) {
    throw new ApiError(
      "NZ today and earlier are locked for self-service changes",
      400,
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;

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

/**
 * Thrown by prepareGuestPlan when a member modification causes the no-adult
 * rule to trip for a booking that was not previously flagged, and the
 * caller did not supply `memberReviewJustification`.
 */
export class BookingModifyReviewJustificationRequiredError extends ApiError {
  // Machine-readable code (#2104) so the modify route can echo it and the member
  // edit panel can reveal the justification field even when the client-side
  // predicate missed the trip (client/server drift). Mirrors the pattern used by
  // OverCapacityConfirmationRequiredError.
  readonly code = "REVIEW_JUSTIFICATION_REQUIRED";

  constructor() {
    super(
      "Removing the last adult requires a written reason so an admin can review. Please add a justification and try again.",
      400,
    );
    this.name = "BookingModifyReviewJustificationRequiredError";
  }
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

/**
 * Bookings converted from (or held for) a public/school booking request keep
 * an officer-negotiated price that was flat-split across the guest rows; the
 * quote's per-tier rates are not persisted on the booking. Every standard
 * edit path reprices the whole booking at current season rates, which would
 * silently replace the negotiated basis — a one-student addition can swing
 * the total by the full quote-vs-season delta (#1032) — so those paths
 * refuse instead and direct the admin to the booking-request re-quote /
 * re-price flow.
 */
export async function isQuotePricedBooking(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<boolean> {
  const request = await db.bookingRequest.findFirst({
    where: {
      OR: [{ convertedBookingId: bookingId }, { heldBookingId: bookingId }],
    },
    select: { id: true },
  });
  return Boolean(request);
}

export const QUOTE_PRICED_EDIT_BLOCK_MESSAGE =
  "This booking keeps a negotiated booking-request price, so standard edits are disabled — they would reprice every guest at season rates. Re-price or issue a revised quote from its booking request instead.";

export async function assertBookingNotQuotePriced(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  if (await isQuotePricedBooking(db, bookingId)) {
    throw new ApiError(QUOTE_PRICED_EDIT_BLOCK_MESSAGE, 400);
  }
}
