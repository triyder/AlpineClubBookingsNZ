# File-size allowances for #4030 (the booking-modified email names added guests)

The owner's decision on #4030 says the member gets "the usual change email
listing the guests and amount". The names travel as one new REQUIRED argument,
`addedGuests`, on `sendBookingModifiedEmail` and the shared change rows, so
every sender of that email has to answer it (`[]` where it adds nobody) — the
house rule for this sender (`financialReviewPending`, `refundByBankTransfer`)
rather than an optional field one path could forget. That costs one line at
each existing call site; none of these files can lose its call site, and
splitting them is unrelated to this change.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 554
reason: one `addedGuests: []` line in the guest-removal route's existing call
  to the booking-modified sender, which the required argument demands.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1686
reason: one line handing the guest-add route's created rows to the
  booking-modified sender, so the member's add-a-guest email names them.

file: src/lib/booking-batch-modification-service.ts
lines: 2926
reason: three lines - the created guest rows carried on the result type, set
  where the result is built, and handed to the change email - which is the
  path both a member's own edit and the officer's finished-stay approval send.

file: src/lib/booking-date-modification-service.ts
lines: 2389
reason: one `addedGuests: []` line at each of the service's two existing calls
  to the booking-modified sender, which the required argument demands.

file: src/lib/email/booking.ts
lines: 1799
reason: the sender's one new required parameter; the rows it composes live in
  booking-money-lines.ts, so nothing else grew here.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 601
reason: the member's request door runs the one dependant-identity rule
  (INV-GUEST-019, #4030 review M4) on the guests it is asked to add, refusing
  with its own message - six lines that belong at this door, beside the other
  refusals the route answers before it writes anything; and the existing
  guests' stay ranges read by the canonical range rule beside the added
  guests' nights (one more line, #4030 re-review of 72c933ffc); and the
  refusal of a moved date the named nights do not reach, chained onto the
  same refusal (nine lines of arguments, #4030 round 7 F2). The range checks
  and every message live in booking-change-request-guests.ts.
