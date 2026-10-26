- **The "refund ledger divergence" alert for a bank-transfer payment now says
  what is usually wrong, where to look, and how to fix it (#4230).** When the
  refunds Xero accounts for on a bank-transfer payment add up to less than the
  refunds the club recorded on it, the booking system keeps its own record and
  alerts the treasurer. The alert used to blame a credit note voided in Xero,
  but it never fires while a voided note is waiting for the nightly follow-up.
  What it usually means is a refund with no credit note of its own: when a
  payment already has its refund credit note, a later refund on it - for
  example a second cancellation refund, or the card-refunded part of an
  approved refund appeal - is counted under that first note and Xero never gets
  a note for it. The alert now names the payment, its booking and the credit
  note whose change raised it, and asks for a note to be raised by hand only
  for a refund whose note was never raised - never for one whose note was
  voided, which is answered on the refund list or Stuck States. The Xero
  guide's troubleshooting table quotes it. Nothing changes in how notes are
  raised; giving each later refund its own note is a separate change (#4287).

  The deploy notes add a read-only query that lists bank-transfer payments
  whose paid-back refunds - hand-backs, a cancelled booking's review refunds
  and card refunds, less bank refunds the void follow-up took back - add up to
  more than their refund credit notes, so officers can raise the missing notes
  by hand. Tests now pin, against a real database, that a group organiser's
  repayment and the recount's handling of a payment's charge records were
  already safe, the current handling of a later refund on a bank-transfer
  payment, and which voided-note states can reach the alert.
