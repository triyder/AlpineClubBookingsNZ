- **A refund appeal can no longer be approved against money a card refund
  still owes (#4124).** A card refund not yet completed - still being sent,
  refused and being retried, or failed after being accepted - stays owed, but
  it had dropped out of the payment's refunded total, so the most an appeal
  could refund rose by the same amount, and approving one could return that
  money twice. The appeal limit now subtracts card refunds still owed, as
  **Refunds owed** counts them: on the approval itself, on the member's
  request, on reopening a dismissed appeal, and on the figures the booking page
  and the refund-requests screen offer. Both screens say when a card refund is
  what lowered the limit, and the approval reads it under the payment's row
  lock, so a refund recorded at that moment cannot slip between its reads.
