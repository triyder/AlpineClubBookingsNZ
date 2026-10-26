- **A windowed deploy can no longer switch on school-adult holds by itself
  (#4027).** Since #3964, the settings for the school-booking unnamed-adult
  holds (`PENDING_SCHOOL_ADULTS_ENABLED` and
  `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED`) reach the app. But a deploy with a
  maintenance window is run with `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` set
  in the operator's shell, and Docker Compose prefers a shell value to `.env`.
  So the new release started with it set. If `.env` already said
  `PENDING_SCHOOL_ADULTS_ENABLED=1`, the holds opened without anyone deciding
  to, and the next ordinary deploy closed them again.

  The production deploy now keeps the shell's
  `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED` for its migration check only and
  never passes it to the app. It also refuses, at step 3 of 20, a
  `PENDING_SCHOOL_ADULTS_ENABLED` set in the shell that differs from `.env`,
  and names both values. Editing `.env` and re-running the deploy is now truly
  the only way to change either setting for the app. If you relied on a shell
  export to give the app either value, put it in `.env` instead. When the shell
  has `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` and `.env` does not, the deploy
  prints a note at step 3 of 20 saying the shell value is for the migration
  check only.

  The upgrade runbook also gains its missing entry and rollback note for the
  other-lodges database change, `20261112010000_other_lodge_beds_and_facilities`,
  which needs a maintenance window.
