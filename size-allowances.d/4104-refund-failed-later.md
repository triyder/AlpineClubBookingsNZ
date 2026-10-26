# File-size allowances for #4104 — a card refund Stripe accepted and failed later is owed again

The rule - whose refund it is, which row owes it, the retry's generation and
the alert - lives in two new modules, `src/lib/card-refund-failed-later.ts`
and `src/lib/card-refund-status-sync.ts`. What each file below gains is the one
place it already owns being told about a refund that failed later.

file: src/lib/payment-transactions.ts
lines: 1621
reason: `recordStripeRefundLedgerEntry`'s guarded counted -> refused write is
  the only place a refund is seen to fail after it counted, so it is where that
  signal is spelled (`failedLater`, transition or replayed), and
  `recordStripeRefundsAgainstTransaction` is the transaction it must be kept
  owed in, under the Payment row lock it already holds - one call into the new
  module and the alert after its own commit. The review round added what only
  this file can do: `refundPaymentTransactions` reads a refund a moving row
  owns as refused and returns the decisions to a caller whose transaction it
  joined, the sync returns them too, and Stripe's cumulative figure no longer
  floors the total (a snapshot from before a refund failed would undo it; it is
  logged instead). Moving any of it out would split the one writer of refund
  rows from the transition it alone can see.

file: src/lib/payment-recovery.ts
lines: 3482
reason: the payments cron's isolated read-back block gains the sibling call
  for ordinary card refunds beside the organiser children's (three lines and a
  comment), so one option still turns both on and a failure in either fails
  neither the other nor the run; and the stale-queue alert, which lives here,
  leaves out a row the runner will never claim (one spread line). Fix round 3
  builds the runner's refund metadata through the one builder the failed-later
  owner check also reads (`cardRefundOperationRefundMetadata`, a net shrink),
  and the superseded refund's replay reads a refund the ledger holds as failed
  as refused (two lines).

file: src/lib/stripe-webhook-service.ts
lines: 1873
reason: the event switch is the one dispatcher of Stripe events; three case
  labels and one call route `refund.failed` (and the two update events) to the
  new recorder, which holds all of the handling.

file: src/lib/booking-cancel.ts
lines: 2851
reason: the cancellation's inline catch is the only place its partial refund's
  answers are in hand, so it marks the slices made before the failure on its
  pre-persisted row (`markCancellationAttempt`, whose body lives in
  `refused-card-refund-retry.ts`) when #4103's refusal re-plan beside it found
  nothing refused: one call, one comment line.

file: src/lib/xero-booking-repair-classify.ts
lines: 2377
reason: the late-capture finding is the one place the repair tool decides how
  much of a cancelled booking's captured card money to offer back (#4128
  review C5). A refund of it that Stripe failed later is owed again by a row of
  its own, so the finding leaves those cents out beside the approval-held
  captures it already leaves out, in the same arithmetic; a helper elsewhere
  would split one sizing across two files.

file: src/lib/xero-operation-outbox.ts
lines: 3330
reason: the refund-note enqueue sizes a paid-another-way close's note, and it
  now caps that at what the close asks for - a close a card note already in
  Xero partly answers asks for less (#4104 review ML1). One `Math.min` and its
  comment, in the one sizing branch that ignored the requested amount.

file: src/lib/xero-credit-notes.ts
lines: 1370
reason: the refund-note executor's card-note branch is the one place a queued
  card note is sized at execution time, so it alone can leave out a "Paid
  another way" close's bank cash that the close's own note answers (#4104 delta
  review A-F2) - a card note queued before its refund failed later would
  otherwise credit Xero a second time. One read through the existing helper
  (`readPaidAnotherWayUncoveredCents`), one subtraction and its comment, the
  same rule the self-heal and the repair tool already apply.
