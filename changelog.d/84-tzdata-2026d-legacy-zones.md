- **The club-timezone test suite no longer depends on which tz database Node ships (triyder/AlpineClubBookingsNZ#84; thatskiff33/AlpineClubBookingsNZ#4303).**
  tzdata 2026d, which arrived with Node 24.22.1, turned `EST5EDT` and
  `PST8PDT` back into POSIX rule zones of their own instead of links to New
  York and Los Angeles, and test cases across five suites that had pinned the
  old link went red on every pull request (or passed by the luck of which
  Node build a test shard drew). Nothing changes for a club: the timezone rule
  still keeps the place a deployment already runs on and still refuses a name
  that is not a place. The suite now asks the runtime which reading applies
  before asserting, and each suite has a case that stands in the runtime so
  the newer reading is exercised on every Node.
