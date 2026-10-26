- **A card refund's credit note is raised again when the note an officer
  resolved by hand is later voided in Xero (#4250).** When a refund credit note
  only partly went through, an officer can mark it resolved in Xero. If that
  note was later voided in Xero, the app still counted it as covering the
  refund, so the nightly check raised no new note and Xero was left with no
  live note for a real refund. A resolved note that Xero records as voided or
  deleted now covers nothing: the refund shows on the list of refunds missing
  a credit note, and the nightly check queues a fresh one. Notes resolved by
  hand that are still live in Xero count exactly as before.

  So after voiding a card refund's credit note in Xero, don't make a
  replacement note by hand: the app raises one overnight, and a hand-made one
  as well would record the refund twice. The resolve dialog in Xero Operations
  now says so for credit notes.
