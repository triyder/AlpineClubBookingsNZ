import type { Prisma } from "@prisma/client";

/**
 * Unpaid finished stays (#1709): bookings still PAYMENT_PENDING whose
 * check-out is on or before NZ today — the stay is over but payment is still
 * owing. Retroactive card creates (#1704) match from the moment of creation;
 * organic bookings that cross check-out unpaid surface here too.
 *
 * Single source of truth for the predicate and deep link shared by the admin
 * dashboard attention card and the sidebar Needs Attention badge (#1731);
 * keep every surface on these helpers so the queues can never drift.
 *
 * This module stays free of runtime Prisma/server imports so the client-side
 * admin sidebar can consume the href builder directly.
 */
export function buildUnpaidFinishedStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    status: "PAYMENT_PENDING",
    checkOut: { lte: today },
  };
}

/**
 * Deep link to the bookings list pre-filtered to the same queue via the
 * Check Out range filter. `todayKey` is the NZ date-only key (YYYY-MM-DD).
 */
export function buildUnpaidFinishedStaysHref(todayKey: string): string {
  return `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=${todayKey}`;
}
