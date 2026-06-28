# State Machines

This is a first-pass map for review planning. It intentionally marks uncertain
or implementation-specific details as "to verify in later review" rather than
inventing certainty.

## Booking Lifecycle

Known schema statuses: `DRAFT`, `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`,
`PAID`, `BUMPED`, `CANCELLED`, `COMPLETED`, `WAITLISTED`,
`WAITLIST_OFFERED`, `AWAITING_REVIEW`.

```text
DRAFT -> PENDING or PAYMENT_PENDING -> CONFIRMED or PAID -> COMPLETED
PENDING -> CONFIRMED/PAID or BUMPED/CANCELLED
WAITLISTED -> WAITLIST_OFFERED -> CONFIRMED/PAID or WAITLISTED/CANCELLED
AWAITING_REVIEW -> CONFIRMED/PAID or CANCELLED
```

To verify in later review: exact terminal transitions, capacity-holding
statuses, non-member hold expiry, school group `CONFIRMED` semantics, and
payment-failure back paths.

### BookingEvent Scope

`BookingEvent` is a durable narrative fact store, not the complete transition
ledger. It stores the facts needed to explain member/admin-visible events such
as creation, payment, bumping, cancellation, refund, and credit outcomes after
AuditLog retention pruning.

Transitions that do not need a narrative fact remain durable through their
own state fields or operational ledgers. For example, waitlist offers and
expiries use booking waitlist fields plus waitlist/audit records, admin review
and force-confirm actions use booking status/admin review fields plus AuditLog,
scheduled completion uses booking status plus CronJobRun, and money/provider
work uses payment, transaction, refund, recovery, and Xero outbox ledgers.

Admin force-confirm records are written in the same transaction as the booking
status change. Explicit overbook overrides use the
`waitlist.force_confirmed_overbook` action with critical severity, preserved
retention, overbooked date-only nights, and an admin waitlist completion report
linking directly to the filtered audit record.

## Booking Modification Lifecycle

Known change request statuses: `REQUESTED`, `APPROVED`, `REJECTED`.

```text
member/admin starts edit -> quoted delta -> local booking mutation
positive delta -> additional payment or supplementary Xero invoice
negative delta -> Stripe refund or source-linked member credit
admin review path -> REQUESTED -> APPROVED or REJECTED
```

To verify: failed post-transaction refund recovery, Xero credit-note creation,
additional-payment cleanup, and bed-allocation reconciliation.

## Public Booking Request Quote Lifecycle

A `BookingRequest` from the public form can be priced through one or more
`BookingRequestQuote` versions. Known quote statuses: `DRAFT`, `SENT`,
`ACCEPTED`, `CANCELLED`, `SUPERSEDED`.

```text
DRAFT -> SENT (admin sends; a SHA-256 response token is issued, time-limited)
SENT  -> ACCEPTED (requester accepts an option; booking conversion runs)
SENT  -> CANCELLED (requester cancels; any held booking is released)
SENT  -> SUPERSEDED (requester asks a question / requests changes, or admin issues a newer quote)
```

Token-link outcomes the requester can see:

- Valid `SENT` link: the quote is shown with options, price, and an expiry hint.
- Not found: `404` "This quote is not valid."
- Status no longer `SENT`: `409` "This quote is no longer active." (use the latest quote email).
- Past expiry: `410` "This quote has expired." with a recover-by-contacting-the-club path.
- Accept after the lodge fills: the request reverts to `QUOTE_SENT`, the link stays
  active, and the requester is told which nights are now full.

Every requester transition (accept, cancel, modification request, question) and the
capacity-blocked accept revert is written to AuditLog with `actor: "requester"`. The
parent `BookingRequest` moves NEW -> VERIFIED -> QUOTED -> QUOTE_SENT and then PRICED
(accept), CANCELLED (cancel), MODIFICATION_REQUESTED, or QUERY_PENDING. When an admin
sends a quote, the email-delivery result is recorded so the team can tell whether the
requester actually received the link.

The response window (default 14 days) and a pre-expiry reminder lead time are
admin-configurable under Booking Policies -> Public Booking Requests. The
`quote-expiry-reminders` cron sends one reminder per quote inside the lead window,
rotating the response token so the reminder email carries a fresh working link
(set the reminder lead to 0 to disable reminders).

School group requests share this quote lifecycle. The public form shows a soft
warning above 25 total students, teachers, and parent helpers because a club
member must host larger groups, but the hard submission limit remains lodge
capacity. Before approval, admins can adjust the bulk child counts; approval
regenerates the school guest list from the preserved teachers/parent helpers and
the adjusted counts, then reprices and rechecks capacity against that final list.

## Payment Lifecycle

Known statuses: `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`,
`PARTIALLY_REFUNDED`. Known sources: `STRIPE`, `INTERNET_BANKING`.

```text
PENDING -> PROCESSING -> SUCCEEDED
PENDING/PROCESSING -> FAILED
SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED
```

To verify: whether Internet Banking uses the same `PaymentStatus` transitions
or Xero invoice state as the effective settlement state.

## Refund And Credit Lifecycle

Known credit types: `CANCELLATION_REFUND`,
`BOOKING_MODIFICATION_REFUND`, `ADMIN_ADJUSTMENT`, `BOOKING_APPLIED`.
Known admin credit adjustment statuses: `PENDING`, `APPROVED`, `REJECTED`.
Known refund request statuses: `PENDING`, `APPROVED`, `REJECTED`.

```text
refund requested -> approved/rejected -> Stripe refund or Xero credit/member credit
admin credit requested -> approved/rejected -> MemberCredit created/applied
MemberCredit available -> applied to booking -> ledger remains linked
```

To verify: all paths that update refunded totals and whether completed refund
requests are represented by status, payment/refund rows, or both.

## Waitlist Lifecycle

```text
capacity unavailable -> WAITLISTED
capacity opens/admin offers -> WAITLIST_OFFERED
offer accepted -> confirmed or paid booking
offer expires/declined -> WAITLISTED or CANCELLED
```

The admin waitlist view decorates active `WAITLIST_OFFERED` rows with the latest
`waitlist-offer` EmailLog status. Failed, exhausted, bounced, or missing delivery
records are surfaced beside the offer with a link to email-deliverability
recovery, so state changes are not hidden behind best-effort email delivery.

## Bed Allocation Lifecycle

Known allocation source: `AUTO` or `MANUAL`.

```text
booking confirmed/paid -> auto allocation proposal
admin manually adjusts -> MANUAL allocation
admin approves -> approved allocation metadata set
booking modified/cancelled/completed/deleted -> allocation reconciliation
```

To verify: approval status representation, conflict handling, per-night guest
uniqueness, and module-disabled behavior.

## Membership Application Lifecycle

Known statuses: `PENDING_NOMINATORS`, `PENDING_ADMIN`, `APPROVED`, `REJECTED`.

```text
application submitted -> PENDING_NOMINATORS
nominations complete -> PENDING_ADMIN
admin approves -> APPROVED -> member/setup/invoice path
admin refreshes pending nomination workflow -> PENDING_NOMINATORS with fresh links
admin replaces an unconfirmed nominator -> PENDING_NOMINATORS with a fresh link
admin rejects (fallback from PENDING_NOMINATORS or PENDING_ADMIN) -> REJECTED
```

An admin may reject from either pending state, but `PENDING_NOMINATORS`
applications have non-destructive recovery first. The reminder cron renews each
unconfirmed nominator link weekly for up to four automatic reminders. The admin
member-applications screen can refresh all pending nominator links immediately,
resetting that four-reminder cycle, or replace an unconfirmed nominator with
another eligible member. Rejecting a `PENDING_NOMINATORS` application remains
the fallback withdrawal/clearance path; `REJECTED` is excluded from the
duplicate-application check, so the applicant can submit a fresh application
when needed. Approval stays restricted to `PENDING_ADMIN`.

To verify: duplicate applicant behavior, nomination expiry, setup invite
creation, Xero entrance-fee invoice path, reminder renewal, admin refresh,
nominator replacement, and email retry behavior.

## Seasonal Membership Type Foundation

```text
built-in type seeded -> admin reviews policy -> type edited/reordered
custom type created -> active -> archived -> reactivated
member role backfill -> current-season assignment created if missing
```

The foundation stores type policy and assignments only. It does not transition
booking, subscription, Xero, or access-control state. `ADMIN` and `LODGE`
current-season assignments seed as Full, but their operational subscription
exemption remains governed by the existing role-based helper until the
enforcement state machine is added.

## Nomination Lifecycle

```text
nomination token created -> nominator opens token while signed in
token expires before confirmation -> weekly reminder issues a fresh token
four automatic reminders exhausted -> admin refresh or replacement path
token accepted -> nomination recorded
all required nominations complete -> application moves to admin review
token expired/invalid/wrong user/replaced -> safe error and retry/admin path
```

To verify: token fields, expiry, reminder counters, ownership checks, replaced
token rejection, and duplicate nomination prevention.

## Membership Cancellation, Archive, And Delete Lifecycle

Known request statuses: `REQUESTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`,
`COMPLETED`.
Known participant statuses: `REQUESTED`, `PENDING_CONFIRMATION`, `DECLINED`,
`APPROVED`, `REJECTED`, `CANCELLED`, `REJOINED`.
Known lifecycle action statuses: `REQUESTED`, `APPROVED`, `REJECTED`.

```text
cancellation requested -> participant confirmations -> admin review
admin approves -> local account/family changes -> Xero cancellation queued -> completed
admin rejects/withdraws -> request closed without lifecycle mutation
archive/delete requested -> second-admin review -> approved/rejected
delete approval -> eligibility re-check -> hard delete only when safe
```

To verify: financial blockers, future booking blockers, family cleanup, Xero
group/archive behavior, and email visibility.

## Family And Dependent Lifecycle

```text
family group created -> dependents/adults linked
adult invitation/request -> pending -> accepted/rejected
dependent inherits email or has explicit email inheritance source
family removal/cancellation/delete -> relationship cleanup while preserving history
```

To verify: non-login adult confirmation, dependent age-up behavior, inherited
email changes, and Xero contact synchronization.

## Email Retry Lifecycle

Known email log statuses: `QUEUED`, `SENT`, `FAILED`, `BOUNCED`.

```text
email queued -> send attempted -> sent
send failure -> retryable failed -> retried by cron
exhausted or suppressed -> admin-visible failure/suppression
```

To verify: retry backoff, suppression handling, and which business-critical
emails require admin alerts.

## Xero Outbox And Reconciliation Lifecycle

```text
local business event -> Xero outbox operation queued
worker claims operation -> provider call -> success or retryable failure
inbound webhook/event recorded -> reconciliation worker processes event
failure -> retry/backoff/admin visibility
```

To verify: status strings, stale processing reset, tenant selection, link
cleanup, and exact retry exhaustion alerts.

## Cron And Recovery Lifecycle

```text
cron request authenticated by CRON_SECRET -> task allowlist/module gate
task records run/claim -> processes due rows
success -> durable state updated
failure -> run/failure visible and retryable where business-critical
```

To verify: which cron jobs record `CronJobRun`, exact statuses, stale queue
health thresholds, and skipped-module reporting.
