# File-size allowances for the booking-fixes branch (whole-lodge payment options)

The whole-lodge approval now leaves the payment method to the member. Every
file below is an existing seam that change had to pass through; each grows by a
few lines of policy inside a decision the file already owns, and none of them
gains a boundary a split could sit on.

file: src/lib/school-booking-request.ts
lines: 3184
reason: the member-choice branch (apply the elected credit, settle at $0
  when it covers the price, or keep the legacy receivable) sits inside the
  one approval transaction, under the locks it already holds; lifting it out
  would separate the money decision from the capacity claim and the
  idempotency fence it is ordered against, which is the pairing the
  #2263 owner decision placed in this file on purpose.

file: src/lib/booking-request.ts
lines: 3081
reason: the request's credit election is one field on the creation write and
  one on the admin serialiser, beside the exclusivity flag it travels with;
  a new module for a boolean would put the request's shape in two places.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 540
reason: the whole-lodge case is a two-line hold exemption and a shared
  status predicate inside the existing lock-ordered switch; a second route
  would duplicate the card-intent retirement and the credit netting it
  must stay in step with.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2737
reason: one optional field on the request type, one prop pass-through and
  two toast branches; the panel is the queue's single composition root and
  the #2263 controls already live in their own file beside it.

file: src/lib/email/booking.ts
lines: 1774
reason: the pay-online shape is a type swap and a spread at the two places
  the sender composes the payment-due note; the composer itself lives in
  email-message-notes.ts, which is where the new wording went.
