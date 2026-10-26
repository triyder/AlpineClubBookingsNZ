- **A booking cancelled because the dates filled up while the member was
  paying no longer says "refunded" before the refund is made (#4125).** The
  cancellation is recorded before the card refund is attempted, and it used
  to say the booking was "cancelled and refunded". Now it says the full amount
  "is being refunded", and the booking page says the booking was cancelled
  because the dates filled up while the payment was going through, rather
  than that the member cancelled it.
- **The refund is recorded once it is made, by whichever attempt makes it.**
  If the immediate card refund fails or the card provider refuses it, the
  app's payment retries make it later, and the retry that makes it now
  records it on the booking's history, so the booking page says it was
  refunded instead of "on its way" forever. The record is written once, for
  the amount actually refunded rather than the full charge, and together with
  the step that marks the refund done, so a crash cannot lose it.
- **A card refund the retries could not make no longer reads as "on its way".**
  On the booking page and the payment link page, a cancelled booking's card
  refund that has not been made yet says where it stands: on its way to the
  member's original payment method while it is being retried, and "the club
  will be in touch" once the retries have stopped. This also applies to the
  card part of a refund split between the card and a bank transfer. One
  wording, "is on its way to your original payment method", is used for a
  card refund not yet made. A booking cancelled because the dates filled up
  no longer mentions the cancellation policy, which did not apply to it, and
  no longer says no payment had been taken. If less than the full charge could
  be refunded automatically, or none of it, it says the club will be in touch
  about the rest, and the club's officers get one email naming that amount.
  Once the rest has been refunded, the page stops saying so.
