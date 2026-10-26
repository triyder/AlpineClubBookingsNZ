- **A bank-transfer booking now records the money its Xero invoice actually
  collected** (#3979). When Xero shows a booking's invoice paid, the app records
  what the invoice took, so a booking whose price (or a change fee) changed
  before its invoice was raised is no longer settled at its old price, and its
  refunds and account credit are worked out from what was really paid. A credit
  note that lowers an invoice nobody has paid yet (*Invoice correction —
  nothing refunded*) is now a price correction, not a refund: a $300 invoice cut
  by $100 and paid $200 shows $200 paid and nothing refunded. When the app
  cannot be sure the payment belongs to the booking alone, or the member paid
  more or less than the booking owes, admins with finance edit access get a
  **Bank transfer amount needs checking** email, which cannot be switched off,
  and a note appears on the booking's history. Bookings settled before this
  change are not rewritten: after upgrading, whoever runs the club's booking
  system should run the settled-cash audit described in the Internet Banking
  guide, which lists any that need correcting.
