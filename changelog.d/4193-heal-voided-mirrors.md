- **The nightly Xero link cleanup now repairs refund credit notes voided in
  Xero before #4091 (#4161, #4192).** If a bank-transfer payment's refund credit
  note was voided in Xero before that fix, the booking system still held it as
  the payment's live refund note. Neither the nightly cleanup nor the
  reconciliation report noticed. Separately, the old cleanup could mark a card
  payment's voided note inactive but leave the payment pointing at it, which
  the report then showed as a missing refund-note link.

  The cleanup now finds every refund note that Xero records as voided or
  deleted and that is still held as live, or is still the note its payment
  points at. It marks each one inactive and moves the payment to its newest live
  note, or to none, through the same step an incoming Xero void uses. Its run
  summary counts what it found and what it healed, and until then the
  reconciliation report lists them as stale links. No money moves, and a second
  run changes nothing. A payment with a refund note still being created in Xero
  is left for the next night, and a heal that fails marks that night's cleanup
  as failed and is retried. Admins who run link maintenance by hand see the
  healed, failed and deferred counts, and every run is recorded in the audit
  log.

  Deploying: while the previous release is still running its cleanup, it can
  leave a payment pointing at an inactive voided note again. The next nightly
  run on this release heals it.
