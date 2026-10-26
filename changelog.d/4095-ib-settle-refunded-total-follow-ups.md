- **Bank-transfer settlement follow-ups (#4095).** A bank transfer whose invoice
  carried an *Invoice correction* note is no longer reported as a "mixed
  invoice" when its booking is cancelled for capacity. When the settle keeps a
  payment's stored figure, an invoice correction already synced is now counted
  as refunded in the same step that records the payment, so the payment's net
  matches the cash, even for a cancellation waiting on that step, instead of
  waiting for another note. A credit-note sync that loses its refunded-total
  recount twice to a concurrent writer now fails its stored event, which is
  retried, instead of leaving the total uncounted. The inbound invoice sync
  clears its overpayment and prepayment count once Xero lists none, and the
  settled-cash audit says when an invoice was last synced before that count was
  recorded. The triage of all thirteen items is in
  [`docs/reviews/2026-10-26-4095-triage.md`](../docs/reviews/2026-10-26-4095-triage.md).
