/**
 * #3955 round 3 (`INV-PAY-119`): the wording for a payable booking that owes
 * nothing — its price plus any change fee recorded on its payment, less any
 * applied account credit, is at or below zero. The payment link's card would
 * charge nothing, so the page offers no payment and no fresh link, and says
 * why: the credit is named only where some is applied (round 4, finding 5).
 *
 * Its own module only because `booking-narrative.ts` is at its size budget;
 * `buildPayableNarrative` there is the one caller, and it decides when this
 * applies (the caller supplied what the booking owes, and it is at or below
 * zero), and whether any credit is applied.
 */
import type { BookingNarrative } from "@/lib/booking-narrative";
import {
  FINANCIAL_REVIEW_NOTHING_MOVED,
  FINANCIAL_REVIEW_NOTHING_TO_DO,
  FINANCIAL_REVIEW_NOTHING_TO_PAY_PREDATES_THE_CHANGE,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
  FINANCIAL_REVIEW_WORKING_IT_OUT,
} from "@/lib/booking-financial-review-copy";

export function nothingToPayNarrative(range: string, creditApplied: boolean): BookingNarrative {
  return {
    state: "nothing_to_pay",
    headline: "Nothing to pay",
    message: creditApplied
      ? `Your booking for ${range} has nothing left to pay — the account credit applied to it covers what it owes.`
      : `Your booking for ${range} has nothing left to pay.`,
    nextStep: "If your bookings page still shows it as unpaid, contact the club and we'll sort it out.",
  };
}

/**
 * #3991: a booking that owes nothing while the club is working out the money
 * for a change the member made (#3033). The payable composition beside it
 * (`buildPayableWithFinancialReviewNarrative`) qualifies a FIGURE — "This amount
 * does not yet reflect the change" — and there is none here, so this one uses
 * the sentence that needs no figure before it.
 *
 * The next step is the paid composition's, not the nothing-to-pay one's: "If
 * your bookings page still shows it as unpaid" is read on the booking page
 * itself, and beside a review the member has nothing to chase — the club will
 * be in touch.
 */
export function nothingToPayWithFinancialReviewNarrative(nothingToPay: BookingNarrative): BookingNarrative {
  return {
    state: "financial_review_pending",
    headline: nothingToPay.headline,
    message: `${nothingToPay.message} ${FINANCIAL_REVIEW_NOTHING_TO_PAY_PREDATES_THE_CHANGE} ${FINANCIAL_REVIEW_WORKING_IT_OUT} ${FINANCIAL_REVIEW_NOTHING_MOVED}`,
    nextStep: `${FINANCIAL_REVIEW_NOTHING_TO_DO} ${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH}`,
  };
}
