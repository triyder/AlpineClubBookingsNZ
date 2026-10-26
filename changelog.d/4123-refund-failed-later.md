- **A card refund the card provider accepted and later reported as failed is
  now owed again (#4104).** The card provider can accept a refund and fail it
  days later, for example when the member's card has been closed. The app
  counted such a refund as paid, so for a cancellation, a booking change or an
  approved refund request the member was never paid back and **Refunds owed**
  did not show it. Now the failed refund is taken back out of what was
  refunded, shows under **Refunds owed** once, the officers are emailed, and it
  is asked for again automatically. If that retry also fails later, it is
  listed under **Card refunds Stripe gave up on** on the Stuck states page for
  the treasurer to close as paid another way. Closing one notes in Xero only
  what the card refund note already there does not cover, and the dialog says
  how much that note covers. A refund made by hand in the card provider's
  dashboard, or an older group refund, is not re-sent; the officers are emailed
  with its refund id (and told not to raise a second Xero note for it), and the audit log records it under **Payment** (one more
  `payment` audit writer: 503 in all). A cancellation's card refund shortfall
  can no longer be marked paid back while such a refund is still owed.
  **Operators:** once the new release alone is serving, add the `refund.failed`
  event to the club's card-provider webhook endpoint (the Stripe setup wizard's
  Webhook step lists every event; see `DEPLOYMENT.md`). It is required: the
  payments cron only catches refunds still pending. **On upgrade:** a refund
  the card provider created before this release that is found failed is not
  re-sent - the member may already have been paid back by hand - but listed
  with its retries spent, for the treasurer to check and close; and check the
  card provider's failed refunds once by hand, as `DEPLOYMENT.md` says.
