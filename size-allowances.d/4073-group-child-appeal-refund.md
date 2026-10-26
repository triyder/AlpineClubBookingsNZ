# File-size allowances for #3956

Four files that were already over budget grow. The organiser-card cap and
reservation live in `organiser-child-refund.ts`, and the after-commit refund run
and the organiser's email live in the new `organiser-child-appeal-refund.ts`, so
what stays behind in each file below is the branch point itself.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 731
reason: the approval's status re-read, cap, claim and reservation must be one
  `lock(1)` transaction (`INV-LOCK-001`), and the new organiser-card branch has
  to sit inside it, beside the existing card and bank-transfer branches,
  choosing which one runs; its two refusals (nothing left, or the group
  cancel's own refund still owed) are answered beside the route's others.
  About half the growth is the existing Stripe refund block re-indented under
  the guard that keeps an organiser-card refund out of it. Moving the
  transaction out would split one lock decision across two files.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 914
reason: one field on the row type, a three-line `appealCeiling` helper that
  both ceiling call sites now use, so the screen offers the figure the
  approval accepts, and the one muted line saying that figure is the group
  organiser's card payment's - or, while the group cancel's own refund is
  still being made, the line saying to approve once it is made in its place
  (a wait, not "nothing left"). Each belongs next to the call site it serves.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 304
reason: the member's appeal caps at the organiser-card figure, read through
  the shared `organiserCardAppealCeilingFor` (the admin list and the booking
  page use it too), and refuses with its own message when that payment has
  nothing left, or a temporary one while the group cancel's own refund is still
  being made. The call and the refusals sit in the route's existing cap
  sequence, beside the ordinary ceiling they replace for such a booking.

file: src/lib/email-message-registry.ts
lines: 2252
reason: the new organiser email's rows (extra tokens, required token,
  trigger metadata, preview sample) and the approved `joinerName` token, each
  in the one table the email-registry contract tests check against.
