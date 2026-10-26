# File-size allowances for #4132

The ledger's order (`createdAt`, then `insertionSeq`) has one home,
`src/lib/payment-ledger-order.ts`. `payment-recovery.ts` grows by its import of
that home; `payment-transactions.ts` grows by one type field, the `insertionSeq`
its planner's comparator reads.

file: src/lib/payment-recovery.ts
lines: 3382
reason: the refund recovery's derive-at-replay slices and its two ledger reads
  must use the shared ledger order rather than a local createdAt sort; the one
  added line is the import of that order, and the readers stay beside the
  recovery they serve.

file: src/lib/payment-transactions.ts
lines: 1618
reason: the card refund planner's row type gains `insertionSeq`, the field its
  shared newest-first comparator reads; the type belongs beside the planner it
  shapes.
