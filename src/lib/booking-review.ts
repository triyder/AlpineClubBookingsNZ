import { AdminReviewStatus, AgeTier, BookingStatus, type Prisma } from "@prisma/client";
import { isCapacityHoldingBookingStatus } from "@/lib/booking-status";

export const ADULT_SUPERVISION_REVIEW_REASON =
  "This booking does not include an adult guest, so it should be reviewed by an admin.";

export function requiresAdultSupervisionReview(
  guests: Array<{ ageTier: AgeTier | string }>
): boolean {
  const hasAdult = guests.some((guest) => guest.ageTier === AgeTier.ADULT);
  const hasMinor = guests.some((guest) =>
    guest.ageTier === AgeTier.CHILD ||
    guest.ageTier === AgeTier.YOUTH ||
    guest.ageTier === AgeTier.INFANT
  );

  return hasMinor && !hasAdult;
}

type ReviewGate = {
  requiresAdminReview: boolean;
  adminReviewStatus: AdminReviewStatus | string | null;
  adminReviewReason: string | null;
};

/**
 * F27 / #1372 + #1422. A booking left with only under-18 guests (no adult) is
 * flagged for admin review and KEPT in its PAID status — never parked to
 * AWAITING_REVIEW, so the captured-money invariant (#1100) holds. While that
 * admin review is still PENDING the booking must be BLOCKED from lodge check-in
 * (a child-safety gate): an admin has to clear the review before the party can
 * arrive.
 *
 * This predicate is the single source of truth for "is this booking blocked
 * from check-in by a pending admin review". #1422 broadened it to key on ANY
 * pending admin review (`requiresAdminReview === true && adminReviewStatus ===
 * PENDING`) rather than the specific adult-supervision reason. This blocks any
 * PAID/COMPLETED booking with a pending admin review; today the only such
 * reason is adult-supervision, but the broadened scope is intentional (owner
 * decision) so a future review type inherits the check-in gate automatically.
 *
 * Safe because every lodge query pre-filters `status IN
 * OPERATIONAL_STAY_BOOKING_STATUSES = [PAID, COMPLETED]`; AWAITING_REVIEW
 * (pre-payment) parked bookings are not in that set, so nothing new is
 * over-blocked.
 */
export function isCheckinBlockedByPendingReview(booking: ReviewGate): boolean {
  return (
    booking.requiresAdminReview === true &&
    booking.adminReviewStatus === AdminReviewStatus.PENDING
  );
}

/**
 * Prisma `where` fragment (AND-able) that EXCLUDES bookings blocked from lodge
 * check-in by a pending admin review (#1372 / #1422). Spread it into any
 * lodge-scoped `booking` filter — never hand-roll the condition — so every
 * check-in enforcement surface (arrive/depart, roster generate/confirm) applies
 * the block identically and the gate can't be applied in one place and missed
 * in another.
 *
 * NOTE (#1422): the guest LIST (check-in roster the kiosk shows staff) no
 * longer spreads this filter — it INCLUDES blocked bookings and flags them via
 * `isCheckinBlockedByPendingReview` so staff can see who is blocked. The
 * mutation/enforcement paths below keep excluding them (defense in depth).
 */
export function checkinNotBlockedByPendingReviewFilter(): Prisma.BookingWhereInput {
  return {
    NOT: {
      requiresAdminReview: true,
      adminReviewStatus: AdminReviewStatus.PENDING,
    },
  };
}

/**
 * Should an admin alert fire because an edit NEWLY dropped a capacity-holding
 * (paid) booking into the minors-only blocked state (#1372)? True only when:
 *   1. the booking now sits in the blocked state (pending minors-only review),
 *   2. it was NOT already in a pending review before the edit (no repeat
 *      alerts just because the guest list shuffled), and
 *   3. it kept a live capacity-holding status (PAID/CONFIRMED/COMPLETED) rather
 *      than being parked to AWAITING_REVIEW — a parked pre-payment booking has
 *      no captured money and is already surfaced to the member, so the email is
 *      the nudge for the paid booking that stays PAID.
 */
export function minorsReviewAlertShouldFire({
  previous,
  updated,
}: {
  previous: {
    requiresAdminReview: boolean;
    adminReviewStatus: AdminReviewStatus | string | null;
  };
  updated: ReviewGate & { status: string };
}): boolean {
  if (!isCheckinBlockedByPendingReview(updated)) return false;

  const wasAlreadyPendingReview =
    previous.requiresAdminReview === true &&
    previous.adminReviewStatus === AdminReviewStatus.PENDING;
  if (wasAlreadyPendingReview) return false;

  return (
    updated.status !== BookingStatus.AWAITING_REVIEW &&
    isCapacityHoldingBookingStatus(updated.status)
  );
}
