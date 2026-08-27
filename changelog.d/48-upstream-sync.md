- **Synced with the upstream project (62 commits), closing the loop on this
  fork's own contributions.** Upstream has now merged everything this fork
  built — the message board with cross-club federation, the booking email's
  add-to-calendar links and rich body editor, and the Whakapapa trails fix —
  each hardened by upstream review on the way in, and this sync brings those
  hardenings home: removed shared posts are now retried until every other
  club's copy is confirmed down (with a moderation-screen notice while one is
  outstanding), one bad post from the network can no longer stall the shared
  board's sync, the six-image limit on posts is enforced everywhere, abandoned
  image uploads are cleaned up even when post retention is off, and a bullet
  list containing a price token no longer blocks saving an email template.
  Also included: upstream's own recent refactors and fixes. No settings
  change and no admin action is needed.
