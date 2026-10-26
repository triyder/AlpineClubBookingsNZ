- **Repairing a partly completed invoice in Xero Operations now respects an
  officer's mark, and closes the operation when it succeeds (#4256).** If an
  officer marked an operation resolved in Xero, or not replayable, while a
  retry of it was already starting, the retry could still go ahead and mark it
  repaired, and two retries at once could both send the payment to Xero. A
  retry now takes the operation first, so the officer's mark wins and the
  retry does nothing. A successful payment repair now also marks the operation
  succeeded, so the booking stops showing the payment as not recorded. If the
  invoice email had also failed, the operation stays partly completed for that,
  and its message now says the email is what is left. A repair interrupted
  part-way (the server stopped) comes back as partly completed when an officer
  uses Mark failed or Reset stale running, so Retry repairs it again. Marking
  an operation not replayable while a retry of it is running is refused with
  "try again when it finishes". Rows repaired before this release stay partly
  completed; retry them once and they close. A retry never sends a payment
  Xero already holds for that invoice, and Reset stale running now says how
  many operations it failed and how many interrupted repairs it returned.
