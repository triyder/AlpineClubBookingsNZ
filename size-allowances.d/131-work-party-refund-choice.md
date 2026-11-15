# File-size allowance for fork #129 (work party refund choice)

file: src/lib/booking-guests.ts
lines: 832
reason: `getAllowedGuestMemberIds` is the one definition of a member's family
  (INV-SSOT). It is now exported for a second reader, "Add to work party", which
  refuses the officer's own and family's bookings; the two-line doc names that
  second use. Moving the function out would split the member-guest boundary
  from the set it is built on.
