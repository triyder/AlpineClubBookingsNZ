import { BookingStatus } from "@prisma/client";

export const CAPACITY_HOLDING_BOOKING_STATUSES = [
  BookingStatus.PAID,
  // COMPLETED means the stay has started or remains operationally active.
  // It must keep consuming lodge capacity until checkout.
  BookingStatus.COMPLETED,
  // CONFIRMED holds capacity for pay-on-account bookings (school groups,
  // issue #709): the booking is confirmed at approval and the lodge is
  // reserved while the emailed Xero invoice is outstanding. It flips to PAID
  // when the invoice is reconciled.
  BookingStatus.CONFIRMED,
  // AWAITING_REVIEW must hold the bed: otherwise another member could book
  // the same dates while an admin is deciding, and approval would overbook.
  BookingStatus.AWAITING_REVIEW,
  // NOTE: PENDING does NOT hold capacity (issue #737). Only bookings with money
  // committed reserve beds; members pay up front and land on PAID. A PENDING
  // booking is a provisional non-member hold that no longer consumes capacity —
  // the bump-on-no-capacity safety in cron-confirm-pending.ts and the
  // most-recent-first bumping in bumping.ts still target PENDING bookings.
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

export function isCapacityHoldingBookingStatus(status: string) {
  return (CAPACITY_HOLDING_BOOKING_STATUSES as readonly string[]).includes(status);
}

export function isOperationalStayBookingStatus(status: string) {
  return (OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(status);
}
