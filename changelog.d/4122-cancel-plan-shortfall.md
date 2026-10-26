- **A card cancellation whose card refund cannot cover the whole refund now
  records the rest, and tells the member honestly (#4097).** A cancellation
  refunds to the card only what the card refund carries: what the payment's
  card charges can still give back. When that was less than the refund the
  cancellation policy gives, usually because the payment's records disagree,
  the difference was only written to the server log: nothing recorded it, and
  the member's email and the cancel confirmation said the whole refund had
  been made. Now the cancellation records the rest on the payments board,
  counted in "Refunds owed", and admins are emailed once. The part the
  payment's other (non-card) charges hold is to be refunded by bank transfer,
  and the member is told so. Anything beyond that - the payment's records show
  it already refunded, or nothing holds it - is a task to check before paying,
  and the member is told only that the club will be in touch about it. The
  booking page says where each part stands. The card refund's booking history
  and its Xero refund credit note are for what the card refund carries.
  Marking a part paid back raises one Xero refund credit note for exactly that
  amount, worded as a bank transfer.

  For treasurers: pay the bank-transfer part by bank transfer and mark it paid
  back once the card part of the refund has gone through (until then the app
  refuses it). For the part to check, look at Stripe and the bank first, and
  dismiss it with a note if the member was refunded.
