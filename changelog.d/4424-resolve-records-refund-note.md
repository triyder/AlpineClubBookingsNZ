- **"Resolve (fixed in Xero)" on a failed refund credit note now asks which Xero
  note you made, and checks it (#4421).** When the app couldn't raise a refund's
  credit note in Xero, an officer could make the note by hand and mark the job
  resolved, but the app never learned which note it was. The same note could
  then also be given as the answer for a different refund, so one $200 note
  covered $400 of refunds and Xero understated the club's refunds.

  Now the dialog asks for the credit note's number and shows the refund's
  amount. The app checks the note in Xero: it must be approved or paid, a sales
  credit note for the booking's Xero contact (the member's, or the
  organisation's) and that exact amount, and not allocated to another invoice.
  It records the note against that refund and watches it, so if the note is
  later voided in Xero the refund goes back on the list to be dealt with. A note
  already recorded against another refund is refused with a plain message, and
  nothing is recorded. The dialog stays open while it checks Xero and shows any
  refusal next to the number. A job whose refund amount can't be read can't be
  resolved this way: the screen says to use **Mark non-replayable** and ask the
  treasurer, rather than making a note by hand. Jobs resolved before this
  release keep no note number.
