/**
 * Centralised status colour utility.
 * Every status must have a unique colour within its category.
 */

import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

// test seam
//
// #2188 P2 — migrated off raw Tailwind colour utilities onto the signed-off
// scale vocabulary (M1-M10, #2181) via CHIP_TONE_CLASSES, which renders the
// `bg-<scale>-3 text-<scale>-11` step pattern (G2b-guaranteed AA, theme-following).
// Every status keeps a UNIQUE tone: the four semantic scales carry the clearly
// semantic states (CONFIRMED=success, CANCELLED=danger, PAID=info,
// PAYMENT_PENDING=warning-primary amber), and the categorical scales cat1..cat5
// carry the sibling states that share a hue family, assigned by hue proximity to
// the previous palette (PENDING yellow→cat5 olive-lime, AWAITING_REVIEW sky→cat2
// cyan, COMPLETED slate→cat3, BUMPED orange→cat4, WAITLISTED purple→cat1).
// WAITLIST_OFFERED keeps the categorical brand-teal (still load-bearing, retires
// in P4). Meaning is always carried by icon + label, never colour alone.
export const bookingStatusClasses: Record<string, string> = {
  DRAFT:            CHIP_TONE_CLASSES.neutral,
  PENDING:          CHIP_TONE_CLASSES.cat5,
  PAYMENT_PENDING:  CHIP_TONE_CLASSES.warning,
  CONFIRMED:        CHIP_TONE_CLASSES.success,
  AWAITING_REVIEW:  CHIP_TONE_CLASSES.cat2,
  PAID:             CHIP_TONE_CLASSES.info,
  COMPLETED:        CHIP_TONE_CLASSES.cat3,
  CANCELLED:        CHIP_TONE_CLASSES.danger,
  BUMPED:           CHIP_TONE_CLASSES.cat4,
  WAITLISTED:       CHIP_TONE_CLASSES.cat1,
  WAITLIST_OFFERED: CHIP_TONE_CLASSES.teal,
};

// test seam
export const bookingStatusLabels: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Pending",
  PAYMENT_PENDING: "Payment Pending",
  // CONFIRMED holds capacity for pay-on-account bookings (see
  // booking-status.ts): the place is secured, the invoice is outstanding.
  CONFIRMED: "Confirmed (Unpaid)",
  AWAITING_REVIEW: "Awaiting Review",
  PAID: "Paid",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  BUMPED: "Bumped",
  WAITLISTED: "Waitlisted",
  WAITLIST_OFFERED: "Waitlist Offered",
};

// test seam
export const paymentStatusClasses: Record<string, string> = {
  PENDING:            CHIP_TONE_CLASSES.warning,
  PROCESSING:         CHIP_TONE_CLASSES.cat3,
  SUCCEEDED:          CHIP_TONE_CLASSES.info,
  FAILED:             CHIP_TONE_CLASSES.danger,
  REFUNDED:           CHIP_TONE_CLASSES.cat1,
  PARTIALLY_REFUNDED: CHIP_TONE_CLASSES.cat4,
};

export function bookingStatusClass(status: string): string {
  return bookingStatusClasses[status] ?? CHIP_TONE_CLASSES.neutral;
}

export function bookingStatusLabel(status: string): string {
  return bookingStatusLabels[status] ?? humanizeStatus(status);
}

/** Render a raw enum value in sentence case, e.g. "PENDING_NOMINATORS" -> "Pending nominators". */
export function humanizeStatus(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

export function paymentStatusClass(status: string): string {
  return paymentStatusClasses[status] ?? CHIP_TONE_CLASSES.neutral;
}

// test seam
export const subscriptionStatusClasses: Record<string, string> = {
  PAID:         CHIP_TONE_CLASSES.success,
  UNPAID:       CHIP_TONE_CLASSES.warning,
  OVERDUE:      CHIP_TONE_CLASSES.danger,
  NOT_INVOICED: CHIP_TONE_CLASSES.neutral,
  NOT_REQUIRED: CHIP_TONE_CLASSES.info,
};

const subscriptionStatusLabels: Record<string, string> = {
  PAID: "Paid",
  UNPAID: "Unpaid",
  OVERDUE: "Overdue",
  NOT_INVOICED: "Not Invoiced",
  NOT_REQUIRED: "Not Required",
};

export function subscriptionStatusClass(status: string): string {
  return subscriptionStatusClasses[status] ?? CHIP_TONE_CLASSES.neutral;
}

export function subscriptionStatusLabel(status: string): string {
  return subscriptionStatusLabels[status] ?? status.replace(/_/g, " ");
}
