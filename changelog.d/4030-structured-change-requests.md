- **A change request now says who is being added, and an officer can enter the
  guests for an older one (#4030).** A member whose stay had started could only
  send the booking officer a free-text note ("can we add these three
  grandchildren"), which named nobody — so once the stay finished, approving it
  could not add or charge anyone.

  The **Admin Request** card on an in-progress stay now lets the member add each
  person with the guest editor's fields — a name and age, one of their own
  family, or a member found through the member-guest finder — and the nights
  each is staying, inside the stay. It shows an estimate of what they will cost
  (adding guests carries no change fee), and the note stays as context. A
  request has to name a change: a note on its own is refused, with a message
  pointing the member at the guests and dates.

  For a free-text request already in the queue, the Changes card on a finished
  stay offers **Guests the member asked to add**: the officer enters the people
  the member described, checks the figures for exactly that list, and **Approve
  and apply** records them on the request as entered on the member's behalf
  (the audit log names the officer and lists them) and applies them through the
  ordinary finished-stay approval — priced at the stay's season rates, no change
  fee, the member guest rules and the overbooking confirmation, the amount due
  raised and settled, and the usual change email. The entry and the approval
  are one step: if the approval is refused, nothing entered is kept.

- **The "Booking Modified" email names the guests a change added (#4030).** It
  used to give only the new guest count. A **Guests Added** line now names each
  person added, with their own nights for anyone not staying the whole stay, on
  every kind of change that adds guests — the member's own edit, an officer's
  edit or approval, and adding a guest from the booking page — in the built-in
  email and in a club's own wording through `{{changeSummary}}`.

- **Review fixes on the change-request work (#4030).** An officer's approval
  now carries the figures they checked, and is refused (nothing applied) if the
  change would charge anything different. Changing the guests they entered
  clears the figures and any overbooking confirmation. A guest named like one
  of the member's dependants must be added as that member, on both the member's
  request and the officer's entry; the message says that a different person who
  shares the name can't be added there. The member's estimate counts member guests
  toward group sizes and says when everyone listed is priced on approval; it is
  rate-limited. A stay range that changes nothing no longer counts as a
  request. The change email marks a member guest who has not yet accepted.
