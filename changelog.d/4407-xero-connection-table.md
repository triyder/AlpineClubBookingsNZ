- **The Xero connection has its own table, with no secret in it (#3806).**
  Whether Xero is connected, to which organisation, and the lock that stops two
  servers refreshing the same Xero sign-in at once now live in a small table of
  their own. The Xero sign-in tokens stay in the encrypted credential store,
  which is now the only copy the app reads. The old token table is kept up to
  date for the previous release during an upgrade and is removed in a later
  release.

  A club already running a build that moved the Xero tokens into the credential
  store (#3454) notices nothing. A club upgrading from v0.13.2, the newest
  tagged release, or anything older reconnects Xero once from Admin → Xero
  after this upgrade; until then Xero shows "reconnect required" and Xero work
  waits. The upgrade notes say how to check, and how to avoid the reconnect.
