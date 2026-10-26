- **A credit note voided in Xero is now recorded here.** Xero's webhook
  names a credit note `CREDITNOTE`. The app was looking for `CREDIT_NOTE`, so
  those events were stored and then ignored, including a void. They now follow
  the same credit-note sync as every other update, and the recorded status
  becomes voided. When the void switches off the note a payment points at (a
  card payment's refund note, or a per-refund note), the pointer moves to
  another live note or is cleared, so the nightly report no longer calls the
  inactive note missing. An internet-banking payment's note stays linked, now
  marked voided.

  Webhook subscriptions are chosen in the Xero developer portal, not in this
  app. Under **My Apps → your app → Webhooks**, tick **Invoices**,
  **Contacts**, and **Credit Notes**. If a void arrived before this change,
  open **Admin → Finance → Xero Sync → Inbound Events**, filter to CREDITNOTE,
  and Replay the event.
