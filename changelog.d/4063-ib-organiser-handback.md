- **An organiser's cancel of a group paid by Internet Banking now asks an
  officer to repay the organiser (#4042).** The cancel already recorded each
  joiner's refund in the app's ledger, and each joiner's email says the club
  will repay the organiser directly, but nothing asked anyone to send the
  money. The cancel now raises one task in **Money to settle** on the payments
  board, on the organiser's booking, holding every joiner refund the ledger
  shows for the group and listing the shares. Admins get the **Manual refund
  needed** email after the cancel has worked through the joiners, worded for a
  group (the cash-booking wording is unchanged); one that could not go out is
  sent on a later run. Re-running the cancel
  adds nothing twice. Marking the task paid back records only that the money
  went, sends nothing to Xero, and is refused if the total has grown since the
  page loaded; the task cannot be dismissed, and an officer who would not
  repay is sent to the treasurer. The task counts in **Refunds owed** but in
  no booking's Net Collected. When the group's paid Xero invoice cannot be
  voided, that alert now points to the task and says how to credit the
  invoice, instead of naming the invoice's paid total. The "Manual refund
  needed" message gains five tokens - `{{handBackNote}}`, `{{handBackLabel}}`
  (both now required), `{{handBackHeading}}`, `{{handBackRecipientLabel}}` and
  `{{handBackAmountLabel}}`; a club that customised it keeps its own wording
  until it adds them.
