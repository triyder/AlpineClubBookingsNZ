# File-size allowance for fork #129 (work party refund choice)

file: src/lib/booking-guests.ts
lines: 832
reason: `getAllowedGuestMemberIds` is the one definition of a member's family
  (INV-SSOT). It is now exported for a second reader, "Add to work party", which
  refuses the officer's own and family's bookings; the two-line doc names that
  second use. Moving the function out would split the member-guest boundary
  from the set it is built on.

file: src/lib/booking-batch-modification-service.ts
lines: 2858
reason: the F20 (#1887) clamp's `refundedExcessCreditCents` (an unpaid booking's
  applied credit freed by a lower price) is carried out of `modifyBookingBatch`
  so a caller can see and check every cent that comes back: one field on each
  of the two result types and one line on each of the three places that build
  them. These are the service's own result shapes; there is no seam to move a
  field of them to.
