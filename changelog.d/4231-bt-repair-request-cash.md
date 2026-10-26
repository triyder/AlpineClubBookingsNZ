- **A bank-transfer payment no longer forgets a refund request it already paid
  back when Xero sends an update (#4215).** When a refund request on a
  bank-transfer booking is paid back, the booking system records the refund on
  the payment and raises the request's own credit note in Xero. But whenever
  Xero then sent an update about the cancellation's refund credit note, the
  payment's account-credit note, or a booking change's credit note on its
  invoice, the booking system recounted the payment's refunded total and left
  out only the cash the refund requests had paid back. The payment then showed
  less refunded than the club had actually paid back. Since the bank-transfer
  floor (#4162) the total no longer drops below what the club recorded, but
  the same recount raised a false "refund ledger divergence" alert instead, and
  a payment it had already lowered stayed low.

  The recount now also counts every refund request the treasurer has marked
  paid back, at the amount recorded then. It does this while the request's
  note is still waiting to go to Xero, after Xero voids it, and when the
  request was paid back before the booking had a Xero invoice, so no note was
  ever raised for it. The request's refund is never added to the cancellation's
  credit note. A voided cancellation credit note is left to the nightly
  follow-up for voided bank-transfer notes (#4162), as before this change; that
  follow-up writes only once `XERO_ENABLE_BANK_REFUND_VOID_WRITES=true`.

  The booking repair tool now reads the same figure. Before, for a request paid
  back before the booking had a Xero invoice, it could offer a cancellation
  credit note that included the request's refund as well. It now leaves that
  refund out, and passes the cancellation's amount to a person when the two
  sit side by side. Such a request also never got its own credit note, because
  the booking had no invoice to credit when it was paid back. Once the invoice
  exists, and only where the payment has no cancellation credit note of any
  kind, the repair tool now offers that note, for the amount paid back, but
  never raises it by itself. Its report starts by asking you to check this
  booking's invoice in Xero for a credit already raised for the request: if
  there is one, nothing more is needed, and the report stays because the app
  cannot record it. Otherwise confirm the action by its key. Where the payment
  may have a cancellation credit note, that note may already include the
  request's refund if it was raised before this release, so the tool offers
  nothing and asks a person to work in two steps: first always compare the
  note's lines in Xero with the cancellation's own refund and edit it in place
  if the request's refund is in it (waiting for a note still queued or failed
  in Xero Operations), then raise the request's credit by hand only if none
  exists yet. It never re-raises a request's note that was voided in Xero: that
  stays the officer's decision.

  A payment that already lost a request's refund this way is not corrected by
  itself: it is recounted only when Xero sends an update about the
  cancellation's credit note, the account-credit note, or a booking change's
  credit note on its invoice (never the request's own credit note), and that
  may not happen again. After deploying, and after any rollback and roll
  forward, run the read-only check in the Xero architecture guide's #4215
  deploy note. It lists the bank-transfer payments that read less refunded than
  their records show. Check each one in Xero, because a cancellation credit
  note voided in Xero is listed too. Then replay one of its stored credit-note
  events from Xero, Inbound events. Stop the previous release's Xero inbound
  worker before this release takes over, because while it runs it can drop the
  request's refund again.

  The same deploy note has a second check for the opposite case. Before this
  release, a cancellation credit note could have been raised for the whole
  refund, including a request's refund that had no note of its own. This
  release then counts that request's refund twice. Such a payment reads more
  refunded than its records show, and the settled-cash audit lists it under
  "folded", which is misleading here. A third check lists every request the
  repair tool sends to a person because its payment has a cancellation credit
  note, whatever the payment shows, so a folded note is found before anything
  is counted twice. To fix one, first always compare the cancellation note's
  lines with the cancellation's own refund - a credit already raised for the
  request does not make this unnecessary. If the request's refund is in it,
  edit the note in place so it carries only the cancellation's own refund (Xero
  needs its allocations and refund payments removed first, and a removed
  reconciled payment's bank line matched again; a lock date blocks the edit
  until the club's adviser lifts it). Then raise the request's credit by hand
  in Xero only if none exists yet. Never void the note: on a bank transfer a
  void puts the refund back on the refund list as owed.
