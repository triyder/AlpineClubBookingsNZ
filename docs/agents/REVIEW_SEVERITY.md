# Review Severity

Use these levels when writing Codex findings, review comments, or issue splits.
Choose severity by realistic impact, exploitability, blast radius, and recovery
cost for this booking, membership, payment, and accounting system.

## Levels

- Critical: likely account, money, booking-capacity, provider, or data
  compromise with broad blast radius, active exploitation path, or no safe
  operator workaround.
- High: serious integrity, privacy, payment, or access-control failure that can
  affect multiple users or durable accounting state, but has constraints or a
  recoverable path.
- Medium: meaningful defect, missing control, or confusing workflow that can
  cause incorrect outcomes for some users or operators.
- Low: limited impact, narrow edge case, minor operability issue, or local
  cleanup with low user risk.
- Informational: documentation, observability, maintainability, or clarity
  improvement with no immediate product risk.

## Examples By Area

| Area | Critical | High | Medium | Low or informational |
| --- | --- | --- | --- | --- |
| Security | Unauthenticated admin mutation, leaked provider secret, bypassable webhook signature | IDOR exposing another member's booking/payment data | Missing rate limit on expensive public route | Inconsistent error copy with no data leak |
| Payments/refunds/credits | Double charge or double refund likely under normal retry | Stripe refund path mutates Internet Banking booking state | Credit ledger can be confusing or missing admin visibility | Missing explanatory copy for refund timing |
| Booking/capacity | Non-holding status consumes beds or confirmed booking does not consume beds | Race can overbook common nights | Waitlist offer expiry lacks clear retry/repair path | Minor wording issue in capacity warning |
| Membership lifecycle | Delete/archive can remove member with financial or booking history | Cancellation approval leaves login or family links active incorrectly | Participant confirmation state lacks admin visibility | Status label is vague |
| Xero/Stripe/SES | Provider webhook not idempotent and replays mutate state | Xero outbox failure is invisible or unretryable | SES failure does not show in admin queue | Non-critical provider error lacks correlation id |
| Data privacy | Public route exposes member PII or export without authorization | Logs contain OAuth code, token, or action-link token | Error details reveal internal object ids unnecessarily | Redaction docs need a new token pattern |
| UI/UX | Flow causes users to pay for wrong booking or hides cancellation consequences | Users cannot tell if payment or application is pending | Missing empty/failure state on admin queue | Button label or help text is unclear |
| Operations/cron | Cron replay causes duplicate provider side effects | Payment recovery queue can stall silently | Health check misses stale retry queue | Cron run label is inconsistent |
