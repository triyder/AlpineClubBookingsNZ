# File-size allowances for #4373 - every Xero outcome carries its claim

The rule itself lives in `xero-operation-outcome-guard.ts`, inside its budget.
Each file below gains only the claim threaded to its own outcome writes: the
claim variable beside the operation id it already held, and the type import.
Splitting any of them for that would move an outcome write away from the call
it records, which is the coupling this change exists to make explicit.

file: src/lib/membership-cancellation-xero.ts
lines: 1406
reason: two credit-note and contact handlers each keep the claim beside the
  operation id they already track, so every complete and fail is written
  under the claim the outbox or the start handed them.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 1027
reason: the type import for the claim the outbox hands the deallocation
  handler; its outcome writes take that claim in place of the bare id.

file: src/lib/xero-booking-invoices.ts
lines: 1663
reason: the create and update handlers keep the claim beside the operation id
  they already track, so the booking invoice replay's completion is written
  under the retry's claim; one type import.

file: src/lib/xero-contact-create-recovery.ts
lines: 868
reason: the type import for the claim the member-contact completion now takes
  in place of the bare operation id.

file: src/lib/xero-contacts.ts
lines: 2068
reason: the resolved-contact record carries the claim instead of the id, and
  the provider-created proof keeps the id it logs beside the claim it fails
  under; one type import.

file: src/lib/xero-credit-notes.ts
lines: 1390
reason: four note handlers keep the queued claim beside the queued id and the
  claim beside the operation id they already track, so every complete, fail
  and allocation failure is written under its claim.

file: src/lib/xero-operation-outbox.ts
lines: 3393
reason: the dispatch keeps the claim its claim helper answers and hands it to
  every handler, and its hand-backs to PENDING are fenced on that claim; the
  two comment lines say why.

file: src/lib/xero-operation-retry.ts
lines: 2084
reason: the retry's claim is handed to its handlers and repairs in place of
  the claimedAt instant, and the claim type import; the membership
  cancellation replay notes it takes no claim.

file: src/lib/xero-sync.ts
lines: 1135
reason: the two outcome writers take the claim; the one added line is the
  claim's comment, which states the rule at the writer.
