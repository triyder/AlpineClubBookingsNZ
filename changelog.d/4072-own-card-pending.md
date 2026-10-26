- **A "Booking Modified" email no longer says a refund to the member's own
  card "has been processed" before it has (#4070).** When an edit lowered the
  price of a booking paid by card and the card refund failed or timed out, the
  refund was queued to be retried, but the email still said it had been
  processed. It now says the refund has been processed only once the card
  refund has gone through; otherwise it says "A refund of $X is on its way to
  your original payment method.", shown as information rather than as a
  success. This covers every edit that can refund the member: changing dates,
  removing a guest, a combined edit, and a re-price after a guest accepts.
  Refunds the club sends by bank transfer keep their existing wording.
