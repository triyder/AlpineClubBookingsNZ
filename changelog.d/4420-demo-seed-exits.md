- **The demo seed now finishes as soon as it is done, instead of waiting five
  minutes (#4412).** After printing its last line it used to sit idle for about
  five minutes before exiting, which slowed every end-to-end test run and any
  local demo setup. It left a database connection open; it now closes it.
