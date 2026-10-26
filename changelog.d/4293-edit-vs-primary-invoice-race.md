- **A booking change made while its Xero invoice is being raised is no longer
  lost from the invoice (#3980).** If a member or officer changed a booking in
  the few seconds the booking's first Xero invoice was being created, the
  invoice could go out with the old guests and price, and nothing in Xero
  carried the difference.

  Now a change saved just as the invoice is linked is refused with "please try
  again in a moment", and nothing is changed; trying again adjusts the invoice
  like any other change. A change that landed a moment earlier is caught when
  the invoice is linked: if the booking is now worth more, the difference is
  billed automatically on a supplementary invoice; if it is worth less, the
  treasurer gets a task in Xero Operations to check the invoice and raise a
  credit note by hand, then choose **Resolve (fixed in Xero)**. The task says
  how the change was settled, so any refund already paid out is accounted for
  too. No credit note is ever raised automatically.

  Not yet covered: when the change asked the member's card for the extra and
  they pay it, that payment is not recorded against the supplementary invoice
  in Xero, which shows it owing until a treasurer matches it. Recording such a
  payment against the right invoice follows in #3953.
