- **A card payment refunded short after the dates filled up is now a task to
  check (#4154).** When a member's card payment completes after the last beds
  went, the booking is cancelled and the card refunded automatically for what
  the payment's records show can go back to the card. When that was less than
  the charge, or nothing, officers were emailed but nothing in the app tracked
  the rest, and the member's page kept saying the club would be in touch.
  The rest now appears in **Money to settle** as a part to check, the same as
  a card cancellation's. Check Stripe and the bank first, since the records may
  be wrong and the money may already have gone back: dismiss it with a note if
  it has, and the member's page says the club checked it and closed it. If it
  really is owed, use **Mark paid back** first, once the card refund has gone
  through, and pay by bank transfer straight after the app accepts: it first
  checks it can record it, only on that card charge. It asks Stripe what the
  charge has refunded, and waits while Stripe shows a refund the app has not
  recorded yet, or cannot be reached. Where the charge's records read more
  refunded than the card refunds on record, it corrects them itself first and
  logs that in the audit log (under Payment, which finance officers read), but
  only for a charge made since the app kept a record of each card refund, on a
  booking with no account credit given back, no other refund task and no Xero
  refund credit note beyond its card refunds. Accepted, it records the refund
  on the booking's ledger, queues its Xero refund credit note, and the member's
  page says the whole payment was refunded; a booking with no Xero invoice to
  credit gets no note. If it refuses, it says why and what to do: dismiss the
  task with a note saying when and how much, and raise the Xero note by hand
  only where it says to. The officers' email now points at the task.
- **Card refund hand-backs are marked first, then paid (#4154).** For a card
  cancellation's parts too - the bank-transfer part and the part to check -
  the queue, the confirm dialog, the officers' email and the refusals now all
  say the same: mark it paid back first, and pay straight after the app
  accepts, so a refusal never comes after the money has gone. Where the
  records show nothing left to refund, the refusal now also says what to do if
  the member really is owed.
- **Officers are told when a card refund lands on a charge already refunded
  (#4154).** If a card refund reaches the app for a charge whose records
  already read fully refunded - for example one made in Stripe after a
  hand-back was marked paid back - officers are now emailed, once, that the
  member may have been paid twice, instead of the extra being dropped silently.
  And a capacity race's part to check can now be marked paid back after the
  nightly Xero check has already raised a card refund note for the same money:
  that note is counted, so no second one is raised.
