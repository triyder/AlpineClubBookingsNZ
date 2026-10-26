# File-size allowances for #4097

A card cancellation whose card refund plan carries less than the refund due now
raises a hand-back task for the rest, tells the member both parts and alerts
the officers. The task, its alert and its reason live in
`cancel-card-refund-shortfall.ts`; these are the call sites and the wording
seams that have to sit where they are.

file: src/lib/booking-cancel.ts
lines: 2859
reason: the task is raised inside the paid cancel's claim transaction, beside
  the card refund plan it measures, under the claim's locks - there is no seam
  outside it with the same client; the card branch then sizes its event and
  Xero note at the card's part, passes the remainder to the email, the result
  and the alert. Each is one call into the helper module.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2258
reason: the money-to-settle card explains each kind of row in its own
  paragraph beside the others, and must not describe a card booking's
  shortfall with the cash paragraph; the paragraph and its row flag belong
  with the sibling kinds' ones.

file: src/lib/email/booking.ts
lines: 1805
reason: the Booking Cancelled sender's `{{refundMessage}}` comes from the one
  wording home and needs the bank-transfer remainder passed through beside
  the other refund arguments.

file: src/lib/email-message-registry.ts
lines: 2308
reason: the Manual refund needed email's description names its third
  situation (a card refund shortfall) beside the cash and group ones, in the
  one registry entry an admin reads.

file: src/lib/email-message-renderer.ts
lines: 959
reason: the {{handBackNote}} requirement's sentence names the third situation
  the token has to explain, in the one guidance table the editor reads.
