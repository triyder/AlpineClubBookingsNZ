- **Approving a change request no longer fills the gaps in a guest's stay
  (#4157).** Some guests stay on nights with gaps between them, for example
  the 10th and the 12th but not the 11th. When a member sent a change request
  with ordinary Date In and Date Out rather than the night-by-night grid, the
  form sent that guest's own dates back unchanged. On a finished stay,
  approving the request then put the guest on every night between those dates
  and charged for the gaps.

  Approving now keeps the nights such a guest already has, and charges nothing
  for them. Only a guest whose dates really change is put on every night of
  their new dates, as before. On a request still waiting for a decision, the
  officer's card on Booking Requests now lists that guest's own nights and
  marks them "(no change)", read from the booking itself, so it matches what
  approving will do even for requests sent before this release. "(fills the
  gaps in their stay)" now appears only where a guest's dates really move.
  Once approved, whether approving applied the change or only acknowledged it
  on a stay still running, the request remembers which guests' dates kept
  their nights, so the card still shows them with "(no change)"; a declined
  request shows the nights the guest held when it was sent. A request
  approved before this release lists such a guest with the dates as asked and
  neither mark, because approving it then filled the gaps (or, on a stay
  still running, only acknowledged it).

  A change request that gives the same guest's dates more than once is now
  refused with a plain message asking the member to check the dates and send
  it again, since approving can apply only one set of dates per guest.
