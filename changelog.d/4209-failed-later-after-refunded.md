- **A cancelled booking no longer says its card refund was made after Stripe
  failed it (#4166).** When a cancellation's card refund was recorded as
  refunded and Stripe later reported that refund as failed, the money was owed
  again and retried, but the member's booking page and payment-link page still
  said it had been refunded on the cancellation's refund date. This applied to
  member cancellations and to bookings cancelled because the dates filled up
  while the payment went through.

  The page now says the failed amount by where its new refund stands: on its way
  to the original payment method, refunded to the card again (with that date),
  being refunded with the club in touch, or paid back another way. Any part of
  the refund that did not fail still reads as refunded on its original date.
  Nothing changes for the club's records or for how a failed refund is retried.
