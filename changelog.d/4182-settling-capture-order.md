- **"Booking may have been paid twice — card and Xero" now names the same card
  payment every time (#4163).** When a booking had been settled by card and its
  Xero invoice was then also paid by bank transfer, the admin alert names the
  card payment that settled the booking. If the booking held more than one card
  capture, which one the alert named was left to chance.

  It now names the earliest capture that no duplicate-capture refund is already
  returning. On a paid booking it skips a capture that was partly refunded
  before the booking moved to Internet Banking; on a cancelled booking such a
  capture is named only if nothing else qualifies. No money moves differently;
  only which capture the alert and its record point at is now predictable. This
  applies to conflicts found from this release; an alert already recorded keeps
  the card it named.
