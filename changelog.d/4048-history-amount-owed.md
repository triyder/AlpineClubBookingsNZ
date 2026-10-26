- **The booking page and the payment step now agree on what is owed
  (#3991).** While the club is checking the money for a change a member made,
  the summary at the top of the booking page shows the amount still to pay.
  It used to show the booking's price on its own, leaving out any change fee an
  officer had recorded and any account credit already applied. It now shows
  what is actually owed: the price plus any recorded change fee, less applied
  credit. That is the same figure the card payment and the emailed payment link
  charge. When credit covers everything, it says there is nothing left to pay
  and names no amount.

  A guest on someone else's booking is no longer told about the owner's
  account credit. The summary names no credit, including on a cancelled
  booking, where "$X was added to your account credit" is dropped and only what
  was retained is said. The booking's history leaves out the "Saved account
  credit was not applied" entry and any "Credit Choice Updated" change, and
  shows a cancellation only as "This booking was cancelled.". That cancellation
  entry's stored wording is free text that can name the credit, so a guest no
  longer sees any of it, including a cancellation reason. A cancelled
  booking's outcome leaves out its "Held as account credit" and "Previously
  applied credit restored" lines and shows "Settled on Cancellation" instead
  of "Credit Issued". That matches the credit-choice notice and pay-card
  credit row they already did not see. The owner, admins, and officers who
  can view bookings (read-only ones included) see everything as before. An
  officer without bookings access can open someone else's booking only as a
  guest on it, and sees what any guest sees. The price, what was paid, what went back to the card and what was
  retained stay visible to the guest, so they can still work the credit out
  by subtraction.

  The page's pay card, and the `{amountDue}` wording in the club's booking
  messages, now take the applied credit from the same record as the payment
  step, so all three agree. Nothing about what is charged changes.
