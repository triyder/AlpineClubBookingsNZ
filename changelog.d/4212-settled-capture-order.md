- **The duplicate-capture refund and the "paid twice — card and Xero" alert
  name the same settling payment (#4177).** When a second card payment lands
  on a booking that is already paid, the club refunds it automatically and
  tells the admins which payment had settled the booking, in the alert email
  and in the booking's admin history. If the booking held more than one
  payment that could have settled it, which one was named was left to chance.

  It now names the earliest qualifying payment wherever it names one, the same
  rule the "paid twice — card and Xero" alert follows (#4163). A card payment
  that is already being cancelled or refunded because a newer one replaced it
  never counts for the refund, and on a paid booking the "paid twice" alert now
  skips it too, while its cancel is under way or its refund has not yet gone
  through. On a cancelled booking the alert still counts it, because the bank
  payment has nowhere else to go. If the earliest is a cash or Internet Banking settlement, no card
  payment is named. A refund the background retry finishes, rather than the
  first attempt, still records no settling payment in the history.

  No money moves differently: the arriving duplicate is still the only payment
  refunded. This applies from this release; alerts and history already
  recorded keep the payment they named.
