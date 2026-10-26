- **A card change's Xero invoice is no longer lost when a later change replaces
  its unpaid payment request (#3403).** When a member did not pay for a change
  by card and a later change asked for that money again together with its own,
  the earlier change's waiting Xero invoice was never sent: it was cancelled a
  day later while the later request still collected the money, leaving card
  money in Stripe that no Xero invoice named until someone ran the
  booking-versus-Xero repair report.

  Now, as the owner decided ("follow the money"), the earlier invoice moves to
  wait on the request that carries its balance. When the member pays that
  request, both invoices go to Xero, each for its own amount and each marked
  paid; the earlier amount is never added to the later invoice. If the member
  never pays, nothing is invoiced, as for any unpaid card change. If the later
  request was already paid when the move happens, the earlier invoice is sent
  straight away. A declined card on the earlier request is covered too, and
  if that declined request is later paid from an old browser tab after all,
  its invoice goes back to it and records that payment instead. If the
  member ends up paying both the old request and the one that took it over,
  the change's invoice still records only one of them; the old request's
  payment, arriving second, is recorded by its own receipt, and where the
  newer request is paid second an officer is told once so the extra can be
  refunded or credited.

  Separately, when several invoices wait on one card payment, Xero now records
  them as paid only while together they add up to no more than the payment;
  one that would not fit is held back and an officer is told, as a single
  invoice larger than its payment already was.

  Nothing changes for bookings paid by internet banking, where each change's
  invoice is already sent unpaid when it is priced. Invoices the system had
  already cancelled this way before this release are left to the repair
  report, which still lists them as a missing supplementary invoice.
