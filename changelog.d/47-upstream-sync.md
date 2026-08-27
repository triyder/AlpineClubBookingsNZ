- **Synced with the upstream project (419 commits).** This fork now carries
  everything the upstream product shipped since the last sync, headlined by
  the Club Time epic: the club's timezone is now a setting (Admin → Club Time
  Zone) rather than the server's environment, every displayed date and
  deadline follows it, and calendar days (lodge nights, roster dates) are
  stored as true dates that no timezone can move. Also included: an
  environment-safety override that lets a staging copy be marked as a copy so
  it can never email real members, Xero sandbox containment, and many smaller
  fixes. The fork's own features — the message board, the booking email
  calendar links and rich editor — are unchanged, with their screens now
  showing times in the club's configured zone like everything else.
