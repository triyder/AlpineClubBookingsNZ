# File-size allowances for #4209 (#4166)

file: src/lib/payment-transactions.ts
lines: 1620
reason: the failed-later row's recorded maker (`madeByOperationId`) is one
  optional field on `RefundAllocationSlice`, the one slice type every refund
  plan reader and writer shares. It belongs beside that type's other per-slice
  marks (`madeRefundId`, `failedRefundIds`); moving the type out of this module
  to add two lines would touch every importer for no gain.
