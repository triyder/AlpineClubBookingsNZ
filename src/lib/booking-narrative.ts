/**
 * One narrative resolver shared by the public payment-link page
 * (`/pay/[token]`) and the admin/member booking-history view so guests and
 * admins read identical wording (issue #740).
 *
 * Given a booking and its durable BookingEvents (plus, on the payment-link
 * page, the link's own expiry/used/revoked state), it returns a state and a
 * rich, plain-language sentence with real amounts and NZT dates, and a concrete
 * self-service next step — never a generic "contact the booking officer"
 * fallback.
 *
 * This module is pure: it reads only the facts handed to it (no database, no
 * `now()` it cannot override) so it is trivially testable and produces the same
 * wording wherever it runs. Money is formatted with `formatCents`, dates with
 * `formatNZDate` (NZT), never raw UTC.
 */
import { BookingEventType } from "@prisma/client";
import { formatCents } from "@/lib/utils";
import { formatNZDate } from "@/lib/nzst-date";
import type {
  CancellationEventSnapshot,
  BumpEventSnapshot,
} from "@/lib/booking-events";

export type BookingNarrativeState =
  | "payable"
  | "expired_payable"
  | "paid"
  | "bumped"
  | "cancelled_pre_payment"
  | "cancelled_post_payment"
  | "declined"
  | "under_review"
  | "unknown";

export interface BookingNarrative {
  state: BookingNarrativeState;
  /** Short title for the card/banner heading. */
  headline: string;
  /** The rich, plain-language sentence(s) describing what happened. */
  message: string;
  /** A concrete self-service next step. */
  nextStep: string;
}

export interface NarrativeEvent {
  type: BookingEventType;
  occurredAt: Date;
  amountCents: number | null;
  reason: string | null;
  snapshot: unknown;
}

export interface NarrativeBooking {
  status: string;
  finalPriceCents: number;
  checkIn: Date;
  checkOut: Date;
  firstName: string;
  adminReviewStatus: string | null;
  adminReviewNotes: string | null;
  adminReviewReason: string | null;
}

interface NarrativeLinkState {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface ResolveBookingNarrativeInput {
  booking: NarrativeBooking;
  events: NarrativeEvent[];
  /** The payment link's own state, when resolving for `/pay/[token]`. */
  link?: NarrativeLinkState | null;
  now?: Date;
}

const PAID_EVENT_TYPES: BookingEventType[] = [
  BookingEventType.MEMBER_PAID,
  BookingEventType.NON_MEMBER_CONFIRMED,
];

const PAYABLE_STATUSES = new Set([
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
]);

function sortedByOccurredAt(events: NarrativeEvent[]): NarrativeEvent[] {
  return [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
  );
}

function dateRange(booking: NarrativeBooking): string {
  return `${formatNZDate(booking.checkIn)} to ${formatNZDate(booking.checkOut)}`;
}

function asCancellationSnapshot(
  value: unknown
): CancellationEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as CancellationEventSnapshot;
  }
  return null;
}

function asBumpSnapshot(value: unknown): BumpEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as BumpEventSnapshot;
  }
  return null;
}

function buildPaidNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[]
): BookingNarrative {
  const paidEvent =
    events.find(
      (e) => PAID_EVENT_TYPES.includes(e.type) && (e.amountCents ?? 0) > 0
    ) ?? events.find((e) => PAID_EVENT_TYPES.includes(e.type));
  const amountCents = paidEvent?.amountCents ?? 0;
  const range = dateRange(booking);

  if (amountCents > 0 && paidEvent) {
    return {
      state: "paid",
      headline: "Payment received",
      message: `Thanks ${booking.firstName} — we've received your payment of ${formatCents(amountCents)} on ${formatNZDate(paidEvent.occurredAt)}. Your stay from ${range} is confirmed.`,
      nextStep:
        "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
    };
  }

  return {
    state: "paid",
    headline: "Booking confirmed",
    message: `Thanks ${booking.firstName} — your stay from ${range} is confirmed. No payment was required.`,
    nextStep:
      "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
  };
}

function buildCancelledPostPaymentNarrative(
  booking: NarrativeBooking,
  paidEvent: NarrativeEvent,
  cancelEvent: NarrativeEvent | undefined,
  settlementEvent: NarrativeEvent | undefined
): BookingNarrative {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  const paidAmountCents = paidEvent.amountCents ?? snapshot?.paidAmountCents ?? 0;
  const settledAmountCents =
    settlementEvent?.amountCents ?? snapshot?.settledAmountCents ?? 0;
  const retainedAmountCents =
    snapshot?.retainedAmountCents ??
    Math.max(paidAmountCents - settledAmountCents, 0);

  const paidOn = formatNZDate(paidEvent.occurredAt);
  const cancelOn = cancelEvent
    ? formatNZDate(cancelEvent.occurredAt)
    : paidOn;
  const opening = `You cancelled this booking on ${cancelOn} after paying ${formatCents(paidAmountCents)} on ${paidOn}.`;

  let settlementClause: string;
  if (settledAmountCents > 0 && settlementEvent) {
    const settledOn = formatNZDate(settlementEvent.occurredAt);
    const verb =
      settlementEvent.type === BookingEventType.CREDITED
        ? "added to your account credit"
        : "refunded";
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents)} was ${verb} on ${settledOn} and ${formatCents(retainedAmountCents)} was retained`
        : `${formatCents(settledAmountCents)} was ${verb} on ${settledOn}`;
  } else {
    settlementClause = `no refund was due and the full ${formatCents(retainedAmountCents)} was retained`;
  }

  return {
    state: "cancelled_post_payment",
    headline: "Booking cancelled",
    message: `${opening} Under the cancellation policy in effect at the time, ${settlementClause}. No further payment is required.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}

function buildCancelledNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[]
): BookingNarrative {
  // A booking held for admin review that was rejected is cancelled via the
  // shared cancel flow; surface it as "declined" with the admin's reason.
  if (booking.adminReviewStatus === "REJECTED") {
    const reason = (booking.adminReviewNotes ?? booking.adminReviewReason)?.trim();
    return {
      state: "declined",
      headline: "Booking request declined",
      message: reason
        ? `This booking request was declined: ${reason}`
        : "This booking request was declined.",
      nextStep:
        "You can adjust the booking — for example, include an adult guest in a youth-only party — and submit it again from the bookings page.",
    };
  }

  const cancelEvent = events.find((e) => e.type === BookingEventType.CANCELLED);

  // A provisional booking whose dates filled up before its guests were
  // confirmed is released (status BUMPED, or CANCELLED carrying a BUMPED event)
  // rather than member-cancelled — no fault, no payment.
  const bumpEvent = events.find((e) => e.type === BookingEventType.BUMPED);
  if (booking.status === "BUMPED" || bumpEvent) {
    const bump = asBumpSnapshot(bumpEvent?.snapshot);
    const releasedAt = bumpEvent?.occurredAt ?? cancelEvent?.occurredAt;
    const releasedClause = releasedAt
      ? ` on ${formatNZDate(releasedAt)}`
      : "";
    const message = bump?.flagged
      ? `These dates filled up before your guests could be confirmed. Because you asked us to only hold the booking if your whole party could come, it was released${releasedClause}. No payment was taken.`
      : `These dates filled up before your guests were confirmed, so this booking was released${releasedClause}. No payment was taken.`;
    return {
      state: "bumped",
      headline: "These dates filled up",
      message,
      nextStep:
        "You're welcome to try again — check current availability and book these dates again.",
    };
  }

  const paidEvent = events.find(
    (e) => PAID_EVENT_TYPES.includes(e.type) && (e.amountCents ?? 0) > 0
  );

  if (paidEvent) {
    const settlementEvent = events.find(
      (e) =>
        e.type === BookingEventType.REFUNDED ||
        e.type === BookingEventType.CREDITED
    );
    return buildCancelledPostPaymentNarrative(
      booking,
      paidEvent,
      cancelEvent,
      settlementEvent
    );
  }

  const cancelOn = cancelEvent ? formatNZDate(cancelEvent.occurredAt) : null;
  return {
    state: "cancelled_pre_payment",
    headline: "Booking cancelled",
    message: cancelOn
      ? `This booking for ${dateRange(booking)} was cancelled on ${cancelOn}. No payment had been taken, so there is nothing to refund.`
      : `This booking for ${dateRange(booking)} was cancelled. No payment had been taken, so there is nothing to refund.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}

function buildPayableNarrative(
  booking: NarrativeBooking,
  link: NarrativeLinkState | null | undefined,
  now: Date
): BookingNarrative {
  const range = dateRange(booking);
  const amountDue = formatCents(booking.finalPriceCents);

  const linkUnusable =
    link != null &&
    (link.revokedAt != null ||
      link.usedAt != null ||
      link.expiresAt.getTime() < now.getTime());

  if (linkUnusable) {
    return {
      state: "expired_payable",
      headline: "Payment link expired",
      message: `This payment link has expired, but your booking for ${range} can still be paid — ${amountDue} is due.`,
      nextStep:
        "Request a fresh payment link below and we'll email you a new one straight away.",
    };
  }

  return {
    state: "payable",
    headline: "Complete your payment",
    message: `Your booking for ${range} is ready to pay — ${amountDue} is due.`,
    nextStep:
      "Pay by card or internet banking below to confirm your booking.",
  };
}

/**
 * Resolve the human narrative for a booking from its durable events. Shared by
 * the public payment-link page and the admin/member booking-history view.
 */
export function resolveBookingNarrative({
  booking,
  events,
  link,
  now = new Date(),
}: ResolveBookingNarrativeInput): BookingNarrative {
  const ordered = sortedByOccurredAt(events);
  const status = booking.status;

  if (status === "PAID" || status === "COMPLETED") {
    return buildPaidNarrative(booking, ordered);
  }

  if (status === "CANCELLED" || status === "BUMPED") {
    return buildCancelledNarrative(booking, ordered);
  }

  if (status === "AWAITING_REVIEW") {
    if (booking.adminReviewStatus === "REJECTED") {
      return buildCancelledNarrative(booking, ordered);
    }
    return {
      state: "under_review",
      headline: "Awaiting review",
      message: `Your booking for ${dateRange(booking)} is waiting for an admin to review it before any payment is taken.`,
      nextStep:
        "No action is needed right now — we'll email you as soon as it's approved.",
    };
  }

  if (PAYABLE_STATUSES.has(status)) {
    return buildPayableNarrative(booking, link, now);
  }

  // DRAFT / WAITLISTED / WAITLIST_OFFERED and any unexpected state: a clear,
  // specific fallback rather than a generic error.
  return {
    state: "unknown",
    headline: "Booking link",
    message: `We couldn't find a payment due for your booking for ${dateRange(booking)} right now.`,
    nextStep:
      "Check the booking on your bookings page, or contact the club if something looks wrong.",
  };
}
