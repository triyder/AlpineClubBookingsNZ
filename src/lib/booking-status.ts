import { BookingStatus, Prisma } from "@prisma/client";

export const CAPACITY_HOLDING_BOOKING_STATUSES = [
  BookingStatus.PAID,
  // COMPLETED means the stay has started or remains operationally active.
  // It must keep consuming lodge capacity until checkout.
  BookingStatus.COMPLETED,
  // CONFIRMED holds capacity for pay-on-account bookings (school groups,
  // issue #709): the booking is confirmed at approval and the lodge is
  // reserved while the emailed Xero invoice is outstanding. It flips to PAID
  // when the invoice is reconciled. School quote acceptances also land here
  // (issue #1254), so an accepted-but-unpaid school booking holds its beds.
  BookingStatus.CONFIRMED,
  // AWAITING_REVIEW must hold the bed: otherwise another member could book
  // the same dates while an admin is deciding, and approval would overbook.
  // The quote lifecycle (issue #1254) also reuses this status for the "sent
  // quote" hold — a sent quote reserves the beds/guest-nights while the
  // requester decides, so it must consume capacity.
  BookingStatus.AWAITING_REVIEW,
  // NOTE: PENDING does NOT hold capacity *by status alone* (issue #737). Members
  // pay up front and land on PAID; split-booking non-member children (#738) and
  // "only-if-my-guests-come" holds are provisional and stay bumpable — the
  // bump-on-no-capacity safety in cron-confirm-pending.ts and the
  // most-recent-first bumping still target those PENDING bookings.
  //
  // EXCEPTION (issue #1254, refines #737): a PENDING booking that is the
  // *converted* booking of a BookingRequest (an accepted-but-unpaid quote, or a
  // directly-approved request) DOES hold capacity until it is paid, expires, or
  // is cancelled. That extension is relation-based (originBookingRequest is
  // set), not status-based, so it lives in `capacityHoldingBookingFilter()`
  // below rather than in this status set. Generic PENDING remains non-holding.
] as const;

export const PAYMENT_OWED_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export const IMMEDIATE_PAYMENT_BOOKING_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
] as const;

// test seam
export const MEMBER_MODIFIABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  // While awaiting review, the member may amend guests (e.g. add an adult
  // to clear the no-adult flag); this is what releases the booking to
  // PAYMENT_PENDING without an admin decision.
  BookingStatus.AWAITING_REVIEW,
] as const;

export const OPERATIONAL_STAY_BOOKING_STATUSES = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
] as const;

export const ACTIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.AWAITING_REVIEW,
] as const;

export function isPaymentOwedBookingStatus(status: string) {
  return (PAYMENT_OWED_BOOKING_STATUSES as readonly string[]).includes(status);
}

// test seam
export function isCapacityHoldingBookingStatus(status: string) {
  return (CAPACITY_HOLDING_BOOKING_STATUSES as readonly string[]).includes(status);
}

// test seam
export function isOperationalStayBookingStatus(status: string) {
  return (OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(status);
}

/**
 * Per-booking analogue of `capacityHoldingBookingFilter()` (the DB-query form
 * below): does THIS booking consume lodge capacity? (issue #1254). A booking
 * holds when its status is capacity-holding, OR it is PENDING and is the
 * converted booking of a BookingRequest (accepted-but-unpaid quote / approved
 * request). Pass `isRequestConverted` = whether the booking has an
 * `originBookingRequest`. Generic PENDING stays non-holding (#737 preserved).
 *
 * Use this wherever a display or decision needs a per-row holding answer (e.g.
 * the bed board's Held vs Provisional tag) instead of the pure status check —
 * `isCapacityHoldingBookingStatus` alone would mislabel a held quote booking.
 */
export function bookingHoldsCapacity(booking: {
  status: string;
  isRequestConverted?: boolean;
}): boolean {
  if (isCapacityHoldingBookingStatus(booking.status)) return true;
  return (
    booking.status === BookingStatus.PENDING &&
    Boolean(booking.isRequestConverted)
  );
}

/**
 * The single source of truth for "which bookings consume lodge capacity" as a
 * Prisma `where` fragment. Use this — never a bare `status: { in: [...] }` — in
 * every occupancy/availability query so the rule stays consistent everywhere.
 *
 * Capacity is held by:
 *   1. Any booking in a capacity-holding status (PAID/COMPLETED/CONFIRMED/
 *      AWAITING_REVIEW), and
 *   2. PENDING bookings that were converted from a BookingRequest — i.e. an
 *      accepted-but-unpaid quote or a directly-approved request (issue #1254,
 *      refining #737). These reserve the bed until payment, expiry, or cancel.
 *
 * Generic PENDING bookings (split-booking non-member children #738, member
 * "only-if-my-guests-come" holds) have no `originBookingRequest`, so they stay
 * non-holding and bumpable — #737 is preserved.
 *
 * The result is a self-contained `AND`-able fragment (its top level is `OR`);
 * spread it into a larger `where` alongside date/exclusion clauses.
 */
export function capacityHoldingBookingFilter(): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] } },
      {
        status: BookingStatus.PENDING,
        originBookingRequest: { isNot: null },
      },
    ],
  };
}

/**
 * Lifecycle order of a booking, for sorting the admin list's status column by
 * lifecycle rather than alphabetically (Decision-menu D9a / #1215). Unknown or
 * future enum values rank LAST so adding a BookingStatus never throws and never
 * scatters rows unpredictably.
 */
const BOOKING_STATUS_LIFECYCLE_ORDER: readonly BookingStatus[] = [
  BookingStatus.DRAFT,
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.CANCELLED,
  BookingStatus.BUMPED,
];

const bookingStatusRankByValue = new Map<string, number>(
  BOOKING_STATUS_LIFECYCLE_ORDER.map((status, index) => [status, index])
);

/** Lifecycle rank for sorting; unknown/future statuses rank last. */
export function bookingStatusLifecycleRank(status: string): number {
  return bookingStatusRankByValue.get(status) ?? BOOKING_STATUS_LIFECYCLE_ORDER.length;
}
