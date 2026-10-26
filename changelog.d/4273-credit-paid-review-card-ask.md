- **When an officer settles a booking-change review as money the member owes,
  a booking paid entirely with account credit is now asked by card (#3947).**
  A booking paid wholly with credit has no card payment behind it. Before this,
  settling such a review as money owed was refused when the booking had no Xero
  invoice, and the officer had to collect the money by hand. When the booking did
  have an invoice, the amount went onto a supplementary Xero invoice instead.

  The member is now asked to pay the extra by card, whether or not Xero is
  connected. This is the rule ordinary booking edits have followed since #3502,
  and the background retry that takes over when Stripe is briefly unavailable
  follows it too. Bookings that already had money taken by card are asked the
  same way as before, and a booking paid by internet banking is still billed
  through its invoice. If an earlier review of the same change was already
  billed on a Xero invoice that is still on its way to Xero (queued, being
  sent, or failed and not yet resolved), a later one goes on that invoice
  rather than to the card, so the member is not asked twice for the same money.
  One case is still open: an officer requeuing a failed invoice after a later
  review of the same change has raised a new one can bill that change twice
  (#4274).
