# File-size allowance for the credit-note webhook fix

file: src/lib/xero-sync.ts
lines: 1108
reason: Clearing the payment's refund-note pointer has to happen in the same
  write that deactivates a VOIDED mirror. Moving that step out of the upsert
  funnel is how the pointer and the link drifted apart.
