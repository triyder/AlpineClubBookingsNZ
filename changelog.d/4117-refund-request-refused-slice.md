- **A refund request's card refund that the card provider refuses is no longer
  lost (#4102).** When an officer approved a refund request and the card
  provider answered the refund straight away as failed or cancelled (rather
  than with an error), nothing was retried and the treasurer's **Refunds owed**
  did not show it. If a refund was split across two card payments, a refused
  part was also dropped when a later part then failed. Now the refused amount
  stays owed: it counts in **Refunds owed**, the officers are emailed once for
  each refused part (and again if the retries run out), and it is retried
  automatically, each retry a fresh request so the provider does not just
  repeat its refusal. A part the provider did refund is never asked for again,
  and is never counted as owed by this or any other refund. If the retry could
  not be queued after the card provider was asked, the approval now stands,
  rather than the request going back for a second approval that could refund
  the same money twice: the officers are emailed, and the refund appeals screen
  says, which part the provider refused (refund it another way) and which got
  no answer (it may have gone back, so check the payment with the card
  provider first). A refund the card provider records later clears it there. The refund appeals screen says what an approved refund still owes -
  queued for retry, out of retries, not queued, or by bank transfer (a
  dismissed transfer counts as not refunded) - and its
  **Refunded** figure is what was actually refunded.
