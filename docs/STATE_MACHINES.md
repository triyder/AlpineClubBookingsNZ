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

Booking quote and create paths reject a linked member who is already present on
another live booking for any requested lodge night. The guard covers draft,
pending, confirmed/paid/completed, waitlist, offered, and admin-review bookings,
but does not change capacity-holding status rules. A member can open their own
conflicting booking, and a linked guest can remove only themselves from another
future booking when they are not the last guest.

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

Cancelled-booking soft-delete is an admin cleanup state, not hard erasure. It
keeps the booking record and remains blocked by captured/refunded/credited
payment, refund, member-credit, payment-recovery, or Xero history. Internal
modification rows with positive and negative cent deltas may be soft-deleted
when those deltas net to zero and no external financial history exists.

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
The non-login records these flows create are classified by `Member.role`, not
counted as paying members: school groups (the school contact and each teacher)
get role `SCHOOL`, and general public booking-request contacts get `NON_MEMBER`.
Both non-member roles grant no access, are excluded from member rosters, and never
owe a membership subscription (see Member roles in `docs/ARCHITECTURE.md`).

After conversion (or while a hold booking exists), the resulting booking keeps
the negotiated flat price and the standard edit endpoints refuse it — editing
a quoted booking's dates or party is done by re-pricing or issuing a revised
quote from the booking request, never by season-rate repricing
(`docs/DOMAIN_INVARIANTS.md`, #1032).

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

## Seasonal Membership Assignment Lifecycle

```text
seed/backfill creates current-season assignment
admin previews member seasonal type change
admin enters reason and saves with matching preview token
audited assignment create/update
season roll-forward dry-run -> reviewed exceptions -> idempotent copy
```

The preview reports future confirmed bookings, draft bookings, waitlist records,
current subscription state, recent subscription history, and resulting booking
and subscription behavior. The save does not reprice existing future bookings,
rewrite subscription/payment/Xero history, or call provider systems. The saved
assignment is enforced the next time a booking is quoted, created, confirmed
from draft, joined, or repriced by an allowed modification path.

## Committee Assignment Lifecycle

```text
seed/migration creates committee master roles with role email aliases
admin creates or archives master role
admin links member to role from member detail
new assignment starts hidden/unpublished
admin edits blurb/sort/published/show-phone/contactable flags
audited assignment update or deactivate
published assignment appears on public committee surfaces
contactable published assignment can receive server-routed contact form mail through the role email alias, or the linked member email when the role email is blank
```

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

On the admin allocation board, dragging or menu-moving the first visible
allocated night for a guest reassigns that guest's visible allocated nights to
the target bed while preserving each date-only lodge night. Later-night moves
remain single-night adjustments.

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

## Seasonal Membership Type Policy

```text
built-in type seeded -> admin reviews policy -> type edited/reordered
custom type created -> active -> archived -> reactivated
member role backfill -> current-season assignment created if missing
type assignment preview -> apply-from date/reason saved -> audited assignment update
booking quote/create/modify -> resolve season assignment/default -> member rate, non-member rate, or block
subscription display/gate -> resolve season assignment/default -> required or not required
```

Runtime booking paths resolve the policy for the booking season. `BLOCK_BOOKING`
stops owners or linked member guests with a structured policy error.
`NON_MEMBER_RATE` uses non-member nightly rates while keeping the stored member
identity. `NOT_REQUIRED` changes effective subscription lockout and display
without deleting raw subscription, payment, or Xero invoice history. `ADMIN` and
`LODGE` operational subscription exemptions remain governed by access-role
helpers, separate from seasonal type policy. The optional assignment `applyFrom`
date is date-only metadata for mid-season changeover reporting and audit; the
guarded preview remains the required save path and existing future bookings are
not automatically repriced by a type or apply-from change.

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

## Lodge Induction Lifecycle

Known induction statuses: `DRAFT`, `IN_PROGRESS`, `COMPLETED`, `VOIDED`.
Known workflow kinds: `NEW_MEMBER`, `HUT_LEADER`, `YOUTH_TO_FULL`,
`RE_INDUCTION`.

```text
admin/application creates induction -> assigned signers review checklist
signer records overall Pass -> sign-off count increments
required sign-offs reached -> COMPLETED
admin override -> COMPLETED
admin void -> VOIDED
```

Checklist templates are versioned and active per workflow kind, so a Hut Leader
Induction can use different checklist wording from a New Member Induction.
Completing a `HUT_LEADER` induction sets the member's hut-leader eligibility
flag. Actual `HutLeaderAssignment` rows remain separate dated roster/coverage
records and are not created by induction completion.

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

## Two-Factor Login Lifecycle

```text
password accepted -> JWT session issued with twoFactorVerified=false
module off -> session treated verified for normal routing
module on + unenrolled -> protected layout redirects to /login/enroll
module on + enrolled -> protected layout redirects to /login/verify
valid TOTP/email/recovery code -> server mints single-use challenge token (hashed, short TTL)
session update carrying that token -> jwt callback consumes it -> twoFactorVerified=true
client-forged session update without a valid token -> ignored, session stays unverified
invalid attempts -> per-member counter increments -> 15 minute lockout after 5 failures
```

To verify: Auth.js JWT callback claim handling, challenge-token single-use
consumption, protected route-group layout redirects, API guard rejection,
email-code expiry, TOTP skew window, recovery code single-use consumption, and
lockout reset after successful verification.

## Analytics Consent Lifecycle

Client-side state machine for the GA4 consent banner (issue #975). The module
must be enabled and `NEXT_PUBLIC_GA_MEASUREMENT_ID` configured before anything
renders at all.

```text
unknown (null) -> banner shown, Google Consent Mode defaults ALL storage to denied
visitor accepts -> choice "accepted" persisted (localStorage analytics-consent.v1) -> GA4 loader script renders + consent update granted
visitor declines or dismisses -> choice "declined" persisted -> GA4 never loads, consent stays denied
stored choice on revisit -> banner suppressed, prior choice honoured
```

To verify: the consent-mode bootstrap (`wait_for_update: 500`, default denied),
the loader rendering only when module enabled + measurement id present +
choice === "accepted", and decline/dismiss both mapping to denied.

## Site Banner Display Lifecycle

Site banners (issue #994) travel a date-window lifecycle plus a per-browser
dismissal state.

```text
upcoming -> current -> past   (inclusive NZ date-only startDate..endDate window)
active toggle off -> hidden regardless of window
visitor dismisses -> hidden in that browser (localStorage site-banners.dismissed.v1)
admin edits the banner -> updatedAt changes -> dismissal invalidated, banner re-shown
```

To verify: the admin page's current/upcoming/past split, the inclusive
date-only comparison in NZ time, and dismissal invalidation keyed on
`updatedAt`.
