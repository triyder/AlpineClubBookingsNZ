# File-size allowances for #3980

An ordinary edit that read no primary Xero invoice link now claims the payment
row against it, and the invoice create measures the booking's whole worth at
its link. The rules live in their own modules (`booking-primary-invoice-claim.ts`,
`xero-primary-invoice-fee-gap.ts`, `xero-primary-invoice-review-task.ts`), and
`booking-modify-settlement.ts` stays inside its budget by moving
`resolveSelectedSettlementAmount` verbatim beside the options it reads. What
each file below adds is only the wiring that has to sit where the edit's
history row, or the create's read, already is.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1691
reason: this door settles for itself instead of through
  `applyPaymentAdjustments`, so its claim on the payment row and its history
  row's marker have to sit in its own transaction beside its settle step.

file: src/lib/booking-batch-modification-service.ts
lines: 2927
reason: its history row carries the marker, and a finished-stay correction
  passes its own refusal wording to the shared settlement.

file: src/lib/booking-date-modification-service.ts
lines: 2389
reason: its history row carries the marker the gap check anchors on; the row
  is written inline here and nowhere else.

file: src/lib/booking-guest-removal-service.ts
lines: 1512
reason: its history row carries the marker the gap check anchors on; the row
  is written inline here and nowhere else.

file: src/lib/xero-booking-repair-classify.ts
lines: 2392
reason: the repair pass decides per edit, inside its one loop, which documents
  an edit expects; a marked edit's "expects none of its own" has to sit beside
  the two arms it switches off, and the reason it is safe is written there.

file: src/lib/xero-booking-invoices.ts
lines: 1657
reason: the create's own figures go to the link's save and, where another
  writer linked the same invoice first, to the re-check that measures them;
  both calls sit where the create's read, lines and invoice already are.

file: src/lib/member-guest-consent-service.ts
lines: 1396
reason: the consent removal mints its re-issued ask and queues its Xero leg
  here, after its commit; the minted intent has to travel from the one to the
  other in this function so a gap invoice waiting on that ask is settled.
