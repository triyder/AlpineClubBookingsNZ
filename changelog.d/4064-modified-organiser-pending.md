- **A joiner's "Booking Modified" email no longer says an organiser-card
  refund "has been processed" before it has (#4057).** When a group booking's
  organiser paid for a joiner's place by card, a reduction to that place is
  refunded to the organiser's card (#3653). The email said the refund had
  been processed even when the card refund failed or had not run yet and was
  still waiting to be retried. It now says the refund has been processed only
  once the card refund has gone through; otherwise it says the refund is on
  its way to the group organiser's card, in the same words the "Booking
  Cancelled" email uses (#3973), shown as information rather than as a
  success. This covers every edit that can refund a joiner: changing dates,
  removing a guest, a combined edit, and a re-price after a guest accepts.
  Every other refund keeps its existing wording.
