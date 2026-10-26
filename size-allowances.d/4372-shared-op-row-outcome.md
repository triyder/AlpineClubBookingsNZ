# File-size allowances for #4372 (#4356) — a Xero operation's outcome never replaces a better one

The rule lives in its own module, `src/lib/xero-operation-outcome-guard.ts`
(`INV-INT-029`). What the outbox gains is the one place it already decides
what a cooldown refusal did to its row being told about that rule.

file: src/lib/xero-operation-outbox.ts
lines: 3391
reason: the cooldown branch's un-claim is the only place the outbox learns
  that its handler's own failure was refused because a caller sharing the row
  recorded a success there. One read of the row, through the guard module's
  `holdsRecordedXeroSuccess`, decides it counts as skipped rather than failed
  and logs that the other caller's outcome stands, beside the un-claim it
  qualifies. Moving it out would split the branch's three outcomes (returned,
  kept, failed) across two files. The busy and cooldown un-claims also spread
  the guard module's `NOT_A_XERO_REPAIR_CLAIM` into their `where`, so neither
  returns a repair's marked claim to PENDING.
