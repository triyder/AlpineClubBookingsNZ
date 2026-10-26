- **The booking-ledger census now explains a refund appeal paid back after a
  cancellation (#4120).** An approved refund appeal gives the member back more
  than the cancellation kept, and no charge line on the ledger says so. So once
  any appeal was paid back, by card or by bank transfer, the census reported
  the cancelled booking as an unexplained difference. It now names it
  `REFUND_APPEAL_PAID`, sized from what each approved appeal has actually
  refunded: the same figure the refund-requests screen shows as "Refunded". An
  appeal not yet paid, dismissed or declined explains nothing, and nor does one
  paid for a different amount than the ledger shows, so those still read as
  differences. An appeal's own bank-transfer task, and its card refund while
  Stripe retries it, are also no longer counted as the cancellation's own
  refund in flight or kept. Because the census now agrees, the ledger
  back-post can post such a booking's history instead of refusing it. As the
  owner decided on #4075, an appeal paid back exactly as recorded is listed
  only and needs no sign-off before the ledger switch-over. The census reads
  only; no money or Xero note changes.

  Also: an appeal refunded to the group organiser's card now counts only once
  that refund is actually made, on the refund-requests screen as in the census.
  And an appeal's card refund closed as "paid another way" for less than was
  owed now counts only the part paid back: the screen says how much "was
  closed without being paid back", and the census agrees with the ledger.
