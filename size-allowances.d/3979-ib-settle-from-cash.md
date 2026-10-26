# File-size allowances for #3979 (settle a bank transfer from its invoice's cash)

Three already-over-budget files grow. The new rules' logic lives in modules of
their own, written to their ceilings - `xero-inbound/settle-from-cash.ts`,
`xero-inbound/settle-from-cash-notice.ts`, `xero-inbound/modification-note-refunds.ts`
and `ib-settlement-figure-note.ts`; what stays in these files is what belongs
where it is.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2060
reason: the receipt figure is decided and written inside the settle's own
  locked transaction, between the #2262 and #3638 fences and the ledger's
  receipt sync, with the payment's projected columns and the durable marker for
  a booking left live, and the in-memory row is updated there so both cancel
  arms size their credit from it. Moving the writes out would split one
  transaction's ordering argument (INV-LOCK-002, INV-PAY-125) across files. The
  decision, the cross-check, the marker and the alert are already elsewhere;
  what is left is the calls, the writes and the cancel arms' invoice-side figure.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1171
reason: the refunded-total repair's own status decision gains the un-refund
  guard and its write the claim on what it read (INV-PAY-126), and its recount
  finds a bank-transfer payment's modification notes by its invoice. All three
  are lines of that one loop, as is its one re-run from scratch when it loses
  its claim to a concurrent settle (#3979 final review); the note-side helpers
  moved out to `modification-note-refunds.ts`.

file: src/lib/email-message-registry.ts
lines: 2307
reason: one more template in the registry's own lists - the admin audience,
  the delivery lock, its required tokens, its trigger summary, its token preview
  and the token list. The registry is the one enumeration the email census
  tests check against; a second file holding one template would defeat them.
