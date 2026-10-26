- **A refund credit note voided in Xero now always stays voided in the app
  (#4288).** An older reading of the note from Xero - from the inbound Xero
  sync, the card refund-note status recorder, or a treasurer's "I already
  recorded it in Xero myself" answer - could arrive after the void had been
  recorded and make the note look live again. The app then counted a voided
  note as covering the refund. On a bank transfer, the sync could also put the
  voided note's amount back into the payment's refunded total. It could also
  record the note's old allocations and refund payments.

  Every reading now carries Xero's own last-updated time, and an older reading
  never overwrites a newer one. A voided note is never made live again: Xero
  never un-voids a note, so re-crediting always takes a new one. If a
  treasurer's "already recorded it" note is voided while the answer is being
  saved, the answer is refused with a plain message and nothing is recorded.
