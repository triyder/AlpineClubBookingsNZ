- **Cron health no longer turns a Xero job amber over one routinely skipped
  row (#4375).** A Xero outbox or replay run that worked its batch, but passed
  over a row another caller had already claimed or finished, was recorded as
  SKIPPED and shown as a warning. It now records SUCCESS. SKIPPED is kept for a
  run that did no work: Xero off or not connected, a credit-sync check that
  already ran this interval, or a sweep with nothing to read. An outbox or
  replay run still shows a warning when rows failed, or when Xero refused rows
  before any call (an outage cooldown, the daily limit or the environment
  check), naming how many and where to look.
