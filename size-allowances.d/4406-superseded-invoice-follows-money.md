# File-size allowances for #3403

file: src/lib/payment-recovery.ts
lines: 3405
reason: the supersede's cancel step must move its change's waiting Xero
  invoice before the recovery row completes, so a crash replays the move; the
  call has to sit in that step (`markSupersededTransactionFailed`, the one
  FAILED write both cancel branches share). The move itself lives in its own
  module (`superseded-ask-invoice-carry.ts`); only the call and its one-line
  reason grow this file, by four lines. Review 2 (F1) adds the same call, two
  lines, to the step's other terminal branch, the captured hand-off to its
  refund (`handoffSucceededSupersededIntentToRefund`).
