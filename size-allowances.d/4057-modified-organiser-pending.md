# File-size allowances for #4057 — an organiser-card edit refund is "made" only when its debt says so

The decision lives in `executeBookingModificationRefund`
(`src/lib/booking-modification-settlement.ts`), and the wording in the copy
home, `src/lib/booking-modified-email-copy.ts`, so neither service gains the
rule. What each of these two services gains is carrying the refund's answer from
where the refund runs (`modifyBookingDates`, `modifyBookingBatch`) to the
post-commit dispatcher that writes the email: the argument, the destructured
parameter, its type, and the type's import. Comments were cut to nothing first;
the other three doors this issue touched stay at their base length. Passing the
answer in, rather than having the dispatcher recompute it from
`result.organiserChildRefund`, is the point of the issue: the plan's yes/no is
what told joiners a failed refund had been processed.

file: src/lib/booking-date-modification-service.ts
lines: 2387
reason: four lines carrying the refund's three-way answer from the refund call
  into `dispatchDatePostTransactionSideEffects`, which sends the email; the
  dispatcher is the only place the email is written, so the answer has to
  reach it as a parameter.

file: src/lib/booking-batch-modification-service.ts
lines: 2923
reason: four lines carrying the refund's three-way answer from the refund call
  into `dispatchBatchPostTransactionSideEffects`, which sends the email; the
  dispatcher is the only place the email is written, so the answer has to
  reach it as a parameter.
