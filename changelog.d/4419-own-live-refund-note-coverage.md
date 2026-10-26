- **A refund's Xero credit-note check now counts only that refund's own live
  note (#4265, #4258, #4321).** The app checks, for each bank-transfer refund,
  whether Xero holds a live credit note covering it. Three things could make
  that check read "covered" when the refund was not.
  - A refund request's own note, resolved by hand in Xero, was counted towards
    the payment's other refunds, and kept counting even after it was voided.
    For example, a $300 request note made a voided $200 cancellation note look
    spare, so the nightly check left a $200 refund with no credit in Xero.
  - A refund closed as "covered by another refund's note" was credited with
    that other refund's whole note.
  - A credit note the app had raised for one refund, whose Xero operation was
    resolved by hand or not yet finished, could also be accepted as the
    hand-made note for another.

  Now a refund counts only its own live note, never a refund request's. A
  voided note that the nightly check judges after this release is undone and
  put back on the refund list as owed, as the check intends. A void the check
  already marked spare before this release stays marked and is not looked at
  again; this release changes no existing record. Answering "already recorded
  it in Xero myself" with a note that such an operation records is refused with
  a plain message, and nothing is recorded. The app still cannot recognise a
  note made by hand in Xero for a failed operation that was then marked
  resolved, because it never learns that note's number.
