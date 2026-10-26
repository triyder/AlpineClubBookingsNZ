- **A late card payment on a cancelled booking is now refunded from that payment
  itself, never from a fee the cancellation kept (#4131).** Take a booking paid by
  a second card charge, where the first payment went through after the booking was
  cancelled. The automatic refund could come partly off the second charge, which
  held the cancellation fee the club kept. The late payment then kept that same
  amount. The member always got the right total back, but Xero could not follow it:
  the nightly refund-note check raised a credit note against the booking's
  original invoice, leaving the Stripe account in Xero short by that amount. The
  refund now always comes off the late payment's own charge, and only for what it
  still holds, so the cancellation fee stays where it was and no extra credit note
  is raised for any late payment refunded on this release. A refund the previous
  release had already split this way is unchanged and is still noted by the
  nightly check, as before. The refund's activity entry now also says how much
  went back now, and how much of the payment had already been refunded.

  **Before deploying:** the previous release kept no record of a refund it had
  only started. If it crashed part-way through refunding a late payment just
  before the deploy, the new release refunds the whole payment again on its own
  charge, so part of it could be refunded twice. Check the Stripe dashboard for
  failing `payment_intent.succeeded` deliveries on cancelled bookings and let
  them settle first, and do not roll back across this release while late
  payments are arriving (see `docs/UPGRADING.md`).
