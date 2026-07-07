import { isPaymentOwedBookingStatus } from "@/lib/booking-status";

export interface DashboardPaymentSnapshot {
  id: string;
  status: string;
  finalPriceCents: number;
  payment: {
    status: string;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
  } | null;
}

export interface DashboardPaymentSummary {
  bookingCount: number;
  totalCents: number;
}

export function getDashboardPaymentOwedCents(booking: DashboardPaymentSnapshot) {
  let owedCents = 0;

  if (
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED"
  ) {
    owedCents += booking.finalPriceCents;
  }

  if (
    booking.payment &&
    booking.payment.additionalAmountCents > 0 &&
    booking.payment.additionalPaymentStatus !== "SUCCEEDED"
  ) {
    owedCents += booking.payment.additionalAmountCents;
  }

  return owedCents;
}

export function isDashboardPaymentOwed(booking: DashboardPaymentSnapshot) {
  return getDashboardPaymentOwedCents(booking) > 0;
}

export function summarizeMemberPaymentOwed(
  bookings: DashboardPaymentSnapshot[],
): DashboardPaymentSummary {
  return bookings.reduce<DashboardPaymentSummary>(
    (summary, booking) => {
      const owedCents = getDashboardPaymentOwedCents(booking);

      if (owedCents > 0) {
        summary.bookingCount += 1;
        summary.totalCents += owedCents;
      }

      return summary;
    },
    { bookingCount: 0, totalCents: 0 },
  );
}
