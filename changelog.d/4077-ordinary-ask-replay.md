- **A price increase whose card request was lost on the way back from Stripe is
  now still asked of the member (#4036).** When a paid booking's price goes up,
  the club asks the member's card for the extra. If Stripe accepted that request
  but its reply never arrived, the automatic retry used to send a slightly
  different request under the same reference, which Stripe refuses, so every
  retry failed and the member was never asked. The retry now sends exactly the
  request the edit sent, and Stripe hands back the card request it already made.
  If Stripe still refuses, the retry finds that request itself: one unpaid
  request for this booking and amount that the club has not recorded. If it
  finds none, more than one, or one that another change to the booking could
  own, it records nothing, keeps retrying, and alerts an administrator as
  before. A school's booking with no saved card customer
  now gets its request when the change is saved, instead of only on the retry.
  Nothing needs doing.
