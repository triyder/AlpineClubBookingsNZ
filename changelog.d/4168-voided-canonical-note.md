- **A refund credit note voided in Xero is no longer treated as the payment's
  refund note (#4091).** Before, when Xero voided the one refund credit note on
  a bank-transfer payment, the booking system kept that note's record active and
  the payment kept pointing at it.

  What you will see now:

  - Once a void reaches the app, the payment no longer points at the voided
    note, and the Xero repair tool no longer offers to point it back or flags it
    as a conflicting reference.
  - On a bank-transfer payment the void undoes the refund, as Xero is the
    payment rail: the refunded amount goes back down and nothing is raised again
    by itself. If the refund really happened, record it again; a fresh credit
    note is then raised.
  - On a card payment a fresh credit note is raised for the refund, as before.
    It is always a new note in Xero, never the voided one handed back.
  - A failed attempt at that fresh note stays in the failed Xero operations list
    with its Retry, instead of being shown as already repaired.
  - If Xero ever answers a refund-note request with a voided note, or with a
    note another refund already raised, the attempt fails in the failed Xero
    operations list with that reason, and nothing is recorded against the
    payment. Check the note in Xero before retrying.
