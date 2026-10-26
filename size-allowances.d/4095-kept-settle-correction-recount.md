# File-size allowance for #4095 items 5 and 12

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2086
reason: the settle's per-payment loop records which applied invoice corrections
  a kept figure leaves uncounted, and calls the recount after its commit, beside
  the other post-commit steps (hosting drain, settlement alert). The recount
  itself lives in its own module, `kept-settle-correction-recount.ts`; only the
  two declarations, the one assignment, the import and the call stay here,
  plus the result's count of notes left unrecounted, which fails the event so
  it is retried.
  The review round adds two lines: the settle hands its invoice id to the
  receipt decision, which counts an applied correction already synced in the
  keep's own transaction, and imports the kept receipt's reason constant from
  `settle-from-cash.ts` instead of spelling it out (`INV-SSOT`).

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1194
reason: review round 2 (L1) makes the refunded-total repair sum a payment's
  modification notes by the same per-note-and-invoice, newest-wins rule the kept
  settle applies. The rule itself lives once in `amounts.ts`
  (`sumAppliedCentsByCreditNote`, `INV-SSOT`); what stays here is the link
  ordering and the allocation key the repair already reads its links for, and
  the null note id a recount with no note being synced passes. Moving that
  into another module would split the repair's one read of its links from the
  loop that uses them.
