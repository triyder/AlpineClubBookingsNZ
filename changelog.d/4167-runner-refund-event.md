- **A cancelled booking's card refund now shows in its history on the day it
  was actually made (#4145).** When a member cancelled a card-paid booking,
  its history recorded "refunded" straight away, even when the card refund had
  failed and was still waiting to be retried. When the automatic retry later
  made the refund, nothing new was recorded, so the history never showed the
  real date.

  The refund is now recorded once, when it is actually made: at the cancel
  when the card refund goes through first time, or when the automatic retry
  makes it later, with the date and amount of that refund. Until then the
  booking page says the refund is on its way, or that the club will be in
  touch if the retries have run out. A refund an officer closes as "Paid
  another way" is shown as paid back another way, not as refunded to the card;
  if part of it had already gone back to the card, the history records that
  part, dated when the card refund was made, and the page names both - for a
  member's cancel and for a booking cancelled because its dates filled up. If
  the club paid back only some of the rest, the page says how much, and that
  the club closed the remainder. A later change to the booking's money (an
  edit review's credit or refund) is no longer shown as the cancellation's
  refund.
