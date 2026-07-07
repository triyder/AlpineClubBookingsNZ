/**
 * Guest-persistence and capacity-range helpers for the booking-creation
 * service, plus the admin-review field resolver.
 *
 * Extracted verbatim from `booking-create.ts`. Depends only on the shared
 * `booking-create-types` module, never on the orchestrator, to avoid an import
 * cycle.
 */
import { AdminReviewStatus } from "@prisma/client";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  addDaysDateOnly,
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
} from "@/lib/date-only";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";
import {
  type BookingGuestInput,
  BookingReviewJustificationRequiredError,
} from "./booking-create-types";

/**
 * Resolve the admin-review fields for a booking based on guest mix and
 * whether the booking is being created by an admin on behalf of a member.
 *
 * Admin-created bookings auto-approve the review (no second pass on their
 * own work). Member-created bookings that trip the rule require a written
 * justification and land with adminReviewStatus = PENDING so an admin can
 * decide via the booking requests queue.
 */
export function resolveAdminReviewFields(args: {
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

export type PricedGuest = {
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

export function getCapacityGuestRanges(
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
export function resolveBookingDateEnvelope(
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

export function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}
