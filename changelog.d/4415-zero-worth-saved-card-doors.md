- **Confirming a free booking's pending guests now records its payment in the
  same step, and the charge-saved-method route no longer tries to charge a
  booking that owes nothing (#4399).** The officer's "confirm pending guests"
  for a booking worth $0 used to write its payment record just after the
  booking was confirmed, so a change fee recorded in that moment could go
  uncollected.
  Both now happen together, as the overnight confirm job already did. The
  charge-saved-method route now refuses a booking worth $0 with a message to
  use "Confirm pending guests". Before, it claimed the booking, asked the card
  provider for a charge too small to make, and then had to undo the claim.
