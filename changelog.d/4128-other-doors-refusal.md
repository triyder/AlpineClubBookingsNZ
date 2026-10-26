- **A card refund the card provider refuses is no longer reported as made,
  wherever it starts (#4103).** Some card refunds - a reviewed change's, an
  approved late card charge's, a duplicate charge's, a refund after the dates
  filled up while the member was paying, and a few automatic ones - could
  still be marked as done when the card provider answered straight away that
  the refund failed or was cancelled, so the member was told they had been
  refunded when they had not. Now the refused amount stays owed: it counts in
  **Refunds owed**, the officers are emailed once, and it is retried
  automatically as a fresh request. An automatic refund of a late card charge
  on a cancelled booking that is refused is held on the payments board for a
  treasurer to approve instead, whatever the club's setting. A late-charge
  refund from the booking repair tool reports the refusal as a failure, and
  running the repair again asks afresh. An old group organiser's refund and
  the refund of a stale group payment report it as a failure too, and are
  retried automatically as a fresh request; the officers are told once.
