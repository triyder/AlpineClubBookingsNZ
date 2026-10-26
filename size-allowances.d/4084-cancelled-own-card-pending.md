# File-size allowances for #4084 — a cancel's own-card refund is "made" only when Stripe's answer says so

The rule lives in the leaf `src/lib/payment-transaction-status.ts`
(`ownCardRefundMade`, shared with Booking Modified), the wording in the copy
home `src/lib/booking-modified-email-copy.ts`, and the on-screen confirmation in
`src/components/cancel-booking-payment-notes.tsx`, so the cancel service gains
only the carrying of Stripe's answer.

file: src/lib/booking-cancel.ts
lines: 2825
reason: the card branch records whether the inline refund call's answer was a
  made refund (a zero plan, which makes no call, counts as made), and hands that one answer to the Booking Cancelled email and to
  the cancel's result, whose type gains the field the confirmation screen
  reads; the refund call, the email call and the result all live in this
  branch, so the answer cannot move without splitting the branch from the
  refund it reports.
