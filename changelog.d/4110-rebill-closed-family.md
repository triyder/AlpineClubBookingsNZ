- **A family whose subscription charge was closed as already paid, or voided
  in Xero, can now be billed again (#4110).** If a payment is reversed after a
  family's charge was closed as already paid, or Xero voided the family's
  invoice, the next billing preview now offers that family a new charge and
  confirming it works. Before, a closed family stayed listed as already billed
  even after a reversal, and confirming a voided family's re-bill failed the
  whole confirmation. Until a payment is reversed, a closed family still counts
  as billed, so a member who joins later is not invoiced for it, and an exempt
  (**Not required**) member whose membership type is changed later doesn't
  count as a reversal: they paid nothing. If such a member now needs a
  subscription, the preview lists them under a new **Needs your decision**
  count, and the family is not billed again: if the family fee already covers
  everyone in the family, mark them Paid; otherwise invoice just the
  difference in Xero by hand. The exception stays open until one of those is
  done; a member who is still exempt isn't listed. If a family has two closed
  charges, only the newest one decides whether the family is billed again, so
  a payment reversed under the older one is listed the same way; when the
  family is billed again, a payment still standing under either charge still
  brings up the **Check before confirming** warning. An invoice Finance raises
  by hand for the difference doesn't stop the family being billed again after
  a later reversal, but the preview warns first that the member already holds
  it (an approval leaves that family for Finance); a parent's own family
  invoice still holds the family back when they were paid at the newest close,
  and a member whose payment is reversed while that invoice holds the family is
  listed under **Needs your decision**, naming the invoice. A member who has moved to another family doesn't
  count either. If only some
  of the members who had paid are no longer paid, the preview shows a **Check
  before confirming** warning that confirming invoices the full family fee.
  Approving a membership application never confirms through that warning: the
  family is left for Finance as an open exception, and the approver is told
  Finance must review it. The club's database gets two small changes to allow
  this: a family can still have only one charge that is waiting to be invoiced
  or has been, per membership type and season; and closing a charge records
  whether each member had paid or was exempt at the time.

  The Subscriptions page also offers **Close: already paid** only when every
  member on the charge has paid or is exempt (**Not required**). When only
  some have, the conflict message says
  to record the remaining payments and then close, or to reverse every payment
  and then Retry, because Retry alone would conflict again. If an invoice
  attempt was already in Xero at the moment a charge was closed, the charge now
  stays closed and names the invoice to void in Xero promptly, rather than
  reopening and emailing it; Xero Operations explains that operation the same
  way. A Retry that loses to a close says there is no work to do.
