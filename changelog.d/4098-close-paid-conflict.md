- **A subscription charge stuck because its members had already paid can now
  be closed (#4098).** When a member is marked paid (usually for cash) after
  their annual charge was queued, the charge correctly raises no Xero invoice and
  shows a conflict on the Subscriptions page, but **Retry** could never clear it,
  so it stayed there for good.

  Admins with finance edit access now get **Close: already paid** on such a
  charge. It asks for a short reason, checks that every member the charge covers
  is still paid, and then marks the charge **Not required**: no invoice is
  raised for it, and the close is recorded in the audit log, under the payment
  category, with who did it and why. Closing twice does nothing more, and the
  close waits until no Xero invoice attempt for the charge is still queued or
  running. If a payment was recorded by mistake, reverse it instead (**Mark as
  unpaid** on the subscription, or void it in Xero) and then **Retry**. If the
  payment is reversed after a close, a member on a per-member charge is billed
  again in the next preview; on a per-family charge the preview still shows the
  family as already billed until #4110 is fixed.

  Conflicts raised from now on name those real choices rather than an action
  that did not exist, and a charge only some of whose members have paid says
  so: reverse the payment and Retry, or record the remaining payments and then
  close it. A charge already in conflict keeps its stored message until it is
  retried.
