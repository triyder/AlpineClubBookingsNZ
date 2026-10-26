- **A late card payment refunded automatically is now always recorded, even if
  the server stops mid-way (#4149).** When a card payment arrives after its
  booking was cancelled, the app refunds it and then records that refund for the
  finance team: the "Refunded automatically" entry, the audit log line, the
  admin alert and the Xero correction. If the server stopped, or the entry could
  not be saved, after the refund went out, that entry was never written - and
  the nightly Xero check then raised a credit note for the whole payment against
  the booking's original invoice, for money Xero never received. Now the alert
  and the audit line still go out at the time, and the missing entry is saved
  when Stripe next sends the payment notice, or by the nightly check before it
  raises any credit note; a payment it cannot check that night gets no credit
  note until it can. A hand-back task still open for that payment is closed
  rather than left asking someone to repay money Stripe already returned. The
  late entry is dated the day the money went back, and the alert is sent again
  with it, since the first may have failed alongside the entry.
- **Stripe's refund notice no longer credits Xero for a late payment it never
  received (#4170, closed here).** When Stripe's "charge refunded" notice
  arrived before the app had recorded a late payment's automatic refund, the app
  queued a credit note for the whole payment against the booking's original
  invoice. It now leaves that refund to the late payment's own record. A late
  payment refunded some other way (the Stripe dashboard), even before Stripe's
  "payment succeeded" notice arrived, is named in the audit log, emailed once
  to everyone who can edit Finance in its own alert that cannot be switched off
  (*Late payment refunded outside the app - check Xero*), and never noted in
  Xero as ordinary cash. The nightly check now also finds a late payment whose
  record was lost even when it shows no gap in Xero (looking back 30 days), and
  a treasurer-approved refund is no longer mistaken for a possible double
  payment; a possible double payment is escalated once, and again if that email
  failed. A late refund the repair tool made is recovered the same way, without
  a "refunded automatically" email, since the repair run already told the
  person who ran it.
- **A refund of a payment made in a stale tab after its booking was cancelled
  is no longer credited in Xero (#4173, closed here).** When a member paid for
  a change in an old tab after the booking was cancelled, the app refunded it
  as a superseded payment, and the nightly Xero check then raised a credit note
  against the booking's original invoice for money Xero never received. That
  refund is now left out of what a credit note may answer, the nightly check no
  longer asks Stripe about it every night, and no alert is sent for it.
