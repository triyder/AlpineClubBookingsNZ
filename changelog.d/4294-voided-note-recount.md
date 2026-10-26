- **Replaying a voided refund credit note in Xero Inbound Events now recounts
  the payment again (#4291).** Before, once the app had recorded that a refund
  credit note was voided in Xero, any later event for that note did not
  recount the payment. This included a retry of the void event after it failed
  partway, a repeat delivery from Xero, or a **Replay** from Inbound Events. If
  the first void event stopped before it recalculated the payment's refunded
  total, the total stayed wrong and a replay could not fix it. A later event
  for a voided note now recalculates the payment's refunded total. The voided
  note stays switched off and is never made the payment's refund note again.
