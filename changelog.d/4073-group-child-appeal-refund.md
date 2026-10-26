- **Approving a refund appeal on a group joiner's booking that the organiser
  paid for by card now actually refunds it (#3956).** When a group organiser
  paid for everyone in one card payment and a joiner then appealed, approving
  the appeal refunded nothing, yet still queued a Xero refund credit note for
  the full amount and told the joiner their refund was on its way.

  The approved amount is now refunded out of the organiser's card payment,
  back to the card the organiser paid with. It is retried automatically if the
  card provider does not answer straight away. The Xero refund credit note is
  queued only once the refund has gone through. The joiner is told the refund
  went (or is on its way) to the organiser's card. The organiser gets a new
  email, **Group Organiser Joiner Refund**, saying the amount for that joiner's
  share is being refunded to their card. The admin's choice not to email covers
  both.

  The most you can approve is what the organiser's payment can still return
  for that booking. Approving more is refused with a message naming how much
  can still be refunded, or saying to decline the appeal when nothing is left.
  The review screen and the joiner's appeal form now show that same figure,
  with a line saying it is refunded to the organiser's card. While an older
  group cancellation's own refund to that card is still being retried,
  approval is refused until it has been made.
