# File-size allowances for #3502 (PR #3948)

The late primary invoice's change-fee line is main's (#3955,
`recordedChangeFeeCents` and the shared `changeFeeLineItem`), so this PR no
longer grows `src/lib/xero-booking-invoices.ts`.

## #3954, built in the same PR: a reduction cancels or shrinks the unpaid ask

The rule, its reads and its writes live in new modules
(`src/lib/additional-ask-reduction.ts`, `src/lib/unpaid-ask-offset-marker.ts`)
and the arithmetic in `additional-payment-ask.ts`. What is left in each
oversized file below is plumbing at a call site that cannot move: a door
recording what its reduction set against the ask on the history row it already
writes, and carrying the retired asks to its after-commit step.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2552
reason: the quote must preview the same offset the save applies, beside the
  give-back preview it already computes in this handler; the read itself is the
  shared `readReductionAgainstUnpaidAsk`, read once.

file: src/lib/booking-batch-modification-service.ts
lines: 2919
reason: the batch door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.
  Round 9: three lines - its member email names the additional figure through
  the shared `additionalAmountToName`, so an ask a reduction retired before it
  was offered is never named as due.

file: src/lib/booking-date-modification-service.ts
lines: 2383
reason: the date door writes its own BookingModification history row and its
  own transaction result; the offset and the retired asks join them there.
  Round 9: three lines - its member email names the additional figure through
  the shared `additionalAmountToName`, so an ask a reduction retired before it
  was offered is never named as due.

file: src/lib/booking-guest-removal-service.ts
lines: 1510
reason: the removal door writes its own BookingModification history row and
  result type; the offset and the retired asks join them there.

file: src/lib/payment-recovery.ts
lines: 3465
reason: the intent-mint replay is where a reduction's re-issued ask is minted
  and its supplementary invoice raised, so the plumbing that cannot move lives
  here: the replay sizes through the shared `sizeRecoveryReplayAsk`, mints a
  re-issue through the request both of its minters send
  (`planReissuedAskMint`, `reissued-ask-mint.ts`), writes its row only while
  it holds its claim and re-checks that claim before queueing any invoice
  (`holdAdditionalIntentRecoveryClaim`), and queues the invoices of the
  re-issues an increase folded in (`queueFoldedReissuedAskInvoices`). The
  rules themselves live in those modules. Round 8: two lines - the replay's
  row also records the edit whose ask it is, in the same upsert.

file: src/lib/xero-booking-repair-classify.ts
lines: 2372
reason: the repair pass sizes a reduction's note and decides an increase's
  missing invoice inside its per-modification arms; the predicate and wording
  live in `unpaid-ask-offset-marker.ts`, and what is left is the arm itself,
  which also reads an increase whose unminted ask a reduction netted off.
  Round 5 moved the scoped side notes' verify-or-queue arm (the give-back's
  and the billed offset's) to `xero-booking-repair-side-notes.ts`. Round 6 adds
  two arms that read the reduction's own history row - a folded re-issue's
  invoice accounted for, and an offset whose billing could not be established
  reported for a person - each a few lines over the shared markers. Round 7
  moved both "could not be established" reports (the offset's and the
  re-issue invoice's) to `addUnpaidAskUnsureFindings` in the side-notes
  module, so the file shrinks. Round 8: three lines - a repair-queued
  billed-offset note learns whether the edit's own note is due (the figure
  the arm below already computed, read a few lines earlier), and a re-issue a
  later reduction retired is not reported unsure twice
  (`isReissueRetiredByLaterReduction`).

file: src/lib/member-guest-consent-service.ts
lines: 1389
reason: a consent decline or expiry is a guest removal with its own
  after-commit finaliser; the asks its reduction retired are cancelled, and what
  is left re-issued, there, through the shared minter, as the DELETE door does -
  also when it netted off an unminted ask and retired no row.

## #3954 review round 4

Re-measured above. What grew is plumbing at call sites that cannot move: each
door reads the unpaid ask once and hands it on, writes the re-issue's recovery
in its own transaction, and tells the member's email whether the ask was
cancelled; the replay holds its claim while it writes, re-sizes a re-issue and
raises its invoice; the repair arm reads the reduction for a retired increase.
The rules themselves live in new modules (`additional-ask-reissue.ts`,
`reissued-ask-invoice.ts`, `xero-booking-repair-intent-recoveries.ts`), which
were split out so `additional-ask-reduction.ts`, `booking-modify-settlement.ts`,
`booking-guest-acceptance-reprice.ts`, `xero-booking-repair-load.ts` and the
HTML email template stay inside their budgets.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 553
reason: the guest-removal route builds the member's Booking Modified email
  from its removal's result; it passes the one required flag saying whether
  the drop cancelled the unpaid additional payment. Round 9: three lines - the
  email names the increase through the shared `additionalAmountToName`, so an
  ask a reduction retired before it was offered is never named as due.

file: src/lib/email/booking.ts
lines: 1798
reason: the Booking Modified sender's flat body composes its payment note
  where the HTML template does; it takes the required cancelled-ask flag and
  appends the shared sentence (`unpaidAskCancelledNote`).

file: src/lib/payment-transactions.ts
lines: 1550
reason: #3954 round 7 - the one ADDITIONAL-row upsert every mint shares
  stamps the asking edit's own invoice answer (`hadIssuedXeroInvoice`) in the
  same write as the row, so a later reduction knows which invoice billed the
  request; a separate write would leave a window where the row exists
  unstamped. Six lines: the optional parameter and its one spread. Round 8:
  the edit whose ask the row is rides in the same write, for the same reason
  - three more lines.
