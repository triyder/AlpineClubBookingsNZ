- **The cancel dialog no longer promises the card more than the cancellation
  will refund to it (#4119).** Since #4097 a card cancellation refunds to the
  card only what the payment's card charges can still give back, and records
  the rest to be refunded by bank transfer, or checked first. The dialog's
  summary still quoted the whole refund as "Refund to card", so a member could
  be told one figure before confirming and a smaller one after. Where the card
  cannot carry the whole refund, the summary now shows the card's part, the
  part the club will refund by bank transfer and the part the club will be in
  touch about, worked out exactly as the cancellation works them out, in the
  cancellation email's wording put in the future tense. The refund option
  names where each part goes. Nothing changes where the card carries the
  whole refund, or for account credit.
