- **A card refund the card provider refuses on a booking change or a
  cancellation is no longer lost (#4083, #4096).** When a booking change
  lowered the price of a booking paid by card, or a cancellation refunded the
  card, and the card provider answered the refund straight away as failed or
  cancelled (rather than with an error), nothing was retried and the
  treasurer's **Refunds owed** did not show it - a cancellation's refund was
  even marked as paid - so the member might never get the money. Now the
  refused amount stays owed: it counts in **Refunds owed**, the officers are
  emailed once for the refusal (and again if the retries run out), and it is
  retried automatically, each retry a fresh request so
  the provider does not just repeat its refusal. If the retries run out it is
  listed for the treasurer to close as paid another way, as any other card
  refund that could not be made is. This covers changing dates, removing a
  guest, a combined edit, a re-price after a guest accepts, and a
  cancellation. Other refunds that can be refused this way (a late card
  charge's, a reviewed change's, a refund request's and a few automatic ones)
  are tracked in #4103 and #4102.
