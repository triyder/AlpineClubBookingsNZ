import { IMMEDIATE_PAYMENT_BOOKING_STATUSES } from "@/lib/booking-status";

export type BookingPaymentMode = "payment" | "setup";

export interface BookingPaymentFlowState {
  status: string;
  hasNonMembers?: boolean | null;
  // Group booking ORGANISER_PAYS: the organiser settles this booking, so the
  // joiner who owns it must never be offered a self-pay flow.
  organiserSettled?: boolean | null;
}

function normalizeBookingState(
  booking: string | BookingPaymentFlowState
): BookingPaymentFlowState {
  return typeof booking === "string" ? { status: booking } : booking;
}

export function requiresSavedPaymentMethod(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);
  return state.status === "PENDING" && state.hasNonMembers !== false;
}

export function canCreateImmediatePaymentIntent(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);

  // The organiser settles ORGANISER_PAYS bookings as one combined bill; the
  // joiner who owns the booking is never billed and cannot pay it here.
  if (state.organiserSettled) {
    return false;
  }

  if (requiresSavedPaymentMethod(state)) {
    return false;
  }

  return (IMMEDIATE_PAYMENT_BOOKING_STATUSES as readonly string[]).includes(state.status);
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}

/**
 * Which unpaid bookings may switch from card to Internet Banking at pay time —
 * the ONE rule the booking page's switch button and the switch route share.
 *
 * - `PAYMENT_PENDING`: the ordinary card booking, as always.
 * - `CONFIRMED` with a whole-lodge hold (fork, booking-fixes): an approved
 *   member whole-lodge booking. Its approval leaves the payment method to the
 *   member, so it is CONFIRMED and capacity-holding through its hold yet owes
 *   its whole price with no receivable minted. Every other CONFIRMED booking
 *   already carries its Internet Banking receivable (school approvals, a card
 *   booking that switched with a bed hold) and is refused by the caller's
 *   "not already Internet Banking" check, not by this rule.
 *
 * The caller still applies its own gates (modules on, not deleted, not
 * organiser-settled, not already Internet Banking, a price to pay).
 */
export function isSwitchableToInternetBanking(booking: {
  status: string;
  wholeLodgeHold?: boolean | null;
}): boolean {
  if (booking.status === "PAYMENT_PENDING") return true;
  return booking.status === "CONFIRMED" && booking.wholeLodgeHold === true;
}
