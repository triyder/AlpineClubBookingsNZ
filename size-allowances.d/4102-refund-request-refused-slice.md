# File-size allowances for #4102 (PR #4117)

The rule of what an approved refund request still owes after its inline card
refund lives in `inlineRefundAfterAttempt` (`refused-card-refund-retry.ts`) and
`queueUnmadeRefundRequestCardRefund` (`refund-request-card-refund.ts`), and the
screen's wording in `refund-request-card-refund-copy.ts`; the approve route did
not grow. What stays in the page is where it renders them.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 950
reason: the approved appeal's Refunded figure and its outstanding lines
  (queued, still owed, not queued and why, by bank transfer, dismissed) sit in the card's
  existing outcome block, and the approval toast reads the route's answer where
  the toast is raised; the figures come from `readApprovedAppealOutcomes` and
  the wording from the shared copy module, so only the render sites are here.
