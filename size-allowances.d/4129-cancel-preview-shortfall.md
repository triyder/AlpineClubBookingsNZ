# File-size allowance for #4119 (PR #4129)

file: src/lib/payment-transactions.ts
lines: 1592
reason: `planCardRefundFromLedger`, the one card refund planner the cancel's
  claim (`planStripeRefundAllocation`) and the cancel preview both call, and
  `legacyBackfillRows`, the pure half of the backfill the preview reads
  without writing (`INV-PAY-131`). Both wrap private steps of this module
  (`buildRefundAllocationSlices`, whose slices must stay byte-identical to the
  inline refund's for its Stripe idempotency keys, and the backfill's
  derivation); moving them out would export those steps or split one
  derivation across two files.
