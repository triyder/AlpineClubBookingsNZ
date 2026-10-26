- **Key-prefix lookups and prefix searches now match their prefix literally
  (#4146).** Prisma's `startsWith` runs as SQL `LIKE`, where `_` matches any
  character and `%` any run, so a lookup whose prefix carried an id could read a
  row belonging to a different booking or group settlement whose id differed
  only at that position. The duplicate-capture refund check (now also scoped to
  its booking) and a group settlement's organiser hand-back tasks now escape the
  prefix through one helper (`exactPrefix`). So do the prefixes people type: the
  admin Xero force-sync's member and booking id lookup, the admin member and
  booking searches, and the member guest search, where typing `%%` previously
  matched every name instead of acting as a prefix. The retirement of a
  payment's pending refund credit note is escaped too, for consistency only: it
  was not reachable, because that query is already scoped to the payment's
  `localId`. A real-PostgreSQL test pins both the wildcard and the fix, and a
  source census (`INV-SSOT-006`) keeps new lookups on the helper.
