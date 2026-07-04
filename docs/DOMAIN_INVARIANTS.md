# Domain Invariants

These are non-negotiable business and technical rules for AlpineClubBookingsNZ.
Future reviews and issues should cite this file when proposing changes.

## Money

- Store and calculate money as integer cents.
- Do not introduce floating point money arithmetic.
- Refunds, credits, discounts, Stripe amounts, Xero invoice amounts, and
  membership fees must reconcile back to cent-based ledger records.
- Admin adjustments need audit, approval, and a visible business reason.

## Booking Dates And Capacity

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics.
- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.
- Only capacity-holding booking statuses consume beds. The implementation
  source of truth is `CAPACITY_HOLDING_BOOKING_STATUSES` in
  `src/lib/booking-status.ts`.
- Waitlisted and offered bookings do not consume capacity until confirmed.
- A waitlist offer reprices the booking at current season rates,
  membership-type policy, group discount, and promo validity at the moment the
  offer is issued; the offer email states the price the member will pay on
  confirmation. The creation-time price snapshot is not a price lock — an
  identical booking made directly on the offer day pays the same. If repricing
  fails, the offer proceeds at the stored snapshot rather than being blocked.
- A linked `Member` may be present on only one live booking per lodge night.
  This person-night guard is separate from bed capacity: it checks draft,
  pending, confirmed/paid/completed, waitlist, offered, and admin-review
  bookings, but ignores cancelled, bumped, deleted, and expired draft rows.
- The person-night guard is app-level enforcement by design (#1039 item 3): a
  database unique index cannot express it because liveness is booking-status
  dependent and spans `BookingGuest` to `Booking`, which a Postgres partial
  unique index cannot reference. It is race-free because every booking
  creation/edit transaction takes the global booking advisory lock before
  running the guard; that ordering is frozen by test.
- A member holds at most one group-join roster row per group
  (`GroupBookingJoin` unique on groupBookingId + joinerMemberId, #1039
  item 2). The roster row is written inside the child booking's transaction:
  a duplicate live join aborts the whole transaction, and a row left by a
  cancelled or bumped join is reused on re-join. Non-member join requests
  carry a NULL member id and sit outside the constraint.
- Draft, pending, waitlist, payment-recovery, and review states must have
  expiry, retry, admin visibility, or repair paths.

## Payment And Settlement

- Stripe and Internet Banking/Xero settlement paths must remain distinct.
- Stripe paths own PaymentIntents, SetupIntents, Stripe refunds, Stripe
  webhooks, and durable PaymentRecoveryOperation rows.
- Internet Banking bookings issue Xero-backed invoices and reconcile settlement
  through Xero invoice/payment state.
- Internet Banking defaults are non-holding and no-cutoff. If bed holding is
  enabled, the hold expiry is snapshotted on the Payment and must be released
  idempotently by cron if unpaid.
- Payment, refund, and credit operations must be idempotent across retries,
  webhook replays, cron reruns, and partial failure recovery.
- External provider side effects require clear retry and idempotency behavior.
- An organiser-pays group settlement applies only when the payment matches the
  sum of the settleable children **at apply time**, re-verified under the lock
  — a child booking edited while the combined intent/invoice was open must not
  auto-settle at the stale total. Mismatches go to operator review: Stripe
  captures are auto-refunded with an admin alert; paid Internet Banking
  invoices stay PENDING with an admin alert.
- Committing organiser-pays group children to CONFIRMED before payment has an
  expiry path: the `group-settlement-reaper` cron releases the beds when the
  settlement stays unpaid past its window (never past check-in), voids the
  open intent, and notifies the organiser and joiners — idempotently, and a
  payment that lands first always wins under the shared lock.
- The reverted children have a terminal path too (#1094): joiners cannot pay
  an organiser-settled booking themselves, so if the FAILED settlement sits
  unretried through a second full reap window the same cron cancels the
  PAYMENT_PENDING children, exactly once, with a joiner notification. A
  settlement retry (which flips the row back to PENDING and resets its clock)
  always keeps the children alive — both are re-checked on the fresh row
  under the shared lock.
- An organiser-cancel group cleanup must be re-drivable after a crash (#1236).
  Cancelling the organiser booking is single-flight, so a re-invoked cancel
  409s and cannot re-enter the joiner cleanup; the `group-settlement-reaper`
  resumes it (an ORGANISER_PAYS group still not CANCELLED under a CANCELLED
  organiser booking, older than a short grace). The per-child refund plan
  (`{childId: cents}`) persisted on the settlement is the **record of record**
  for the organiser-settled per-child `refundedAmountCents` mirror: a re-drive
  **reconstructs it verbatim and never recomputes** — a >24h re-drive can land
  in a different cancellation tier, so recomputing the mirror amount would be
  unsafe. The plan is written before the Stripe refund and before the
  settlement flips, so the refund fires at most once across re-drives. (Resume
  completes the local booking/capacity/refund-mirror cleanup only; it does not
  re-enqueue a Xero refund credit note for a child that crashed after its
  cancel committed but before its credit note was queued — pre-existing
  books-drift of the #1233 reconcile class.)

## Booking Modifications

Booking changes must not orphan or desynchronize:

- Guests and per-guest stay ranges
- Payments and PaymentTransaction rows
- Refunds and member credits
- Xero invoices, payments, credit notes, and object links
- Bed allocations
- Audit records
- Emails and notification state
- Waitlist and capacity decisions

Positive deltas, negative deltas, credits, refunds, and additional payments must
remain traceable to the original booking and modification event.

Per-guest stay ranges must sit inside the parent booking's checkIn/checkOut
envelope. A guest stay range outside the current envelope is not rejected —
it auto-expands the booking's dates (issue #713). The database enforces the
envelope as a safety net with deferred constraint triggers
(`BookingGuest_stay_range_within_booking`,
`Booking_dates_consistent_with_guests`) that validate at COMMIT, so a
transaction may widen guest rows before the parent booking row; only the
committed state must satisfy the invariant. The modification services call
`assertBookingEnvelopeInvariants` (`SET CONSTRAINTS … IMMEDIATE`) as the last
statement of their transactions so a violation is attributed to the calling
service rather than surfacing as an anonymous commit failure; the modify
routes recognise the constraint errors via
`isBookingEnvelopeInvariantViolation` and return a clean 500 instead of
leaking raw trigger text to the client.

Nightly prices lock at booking time: every edit path — batch modify, date
change, guest add, single-guest removal, and the modify-quote preview — prices
only the changed guests/nights at current season rates. A night a guest
already bought keeps the price stored on its `BookingGuestNight` row, so a
season-rate change between booking and edit never rolls into unchanged nights
(adding one guest costs exactly that guest's price; removing one returns
exactly theirs, policy permitting). Edits also price each untouched guest over
exactly the night set they hold (#1093): a partial-stay guest never grows
phantom nights because an unrelated guest was added or removed. A booking date
change is the deliberate reset: it moves every guest — partial stays included —
onto the full new range (the batch-path policy) and re-syncs their
`BookingGuestNight` rows to the newly priced nights, and a guest added mid-life
gets night rows at creation so later edits honour the prices they joined at.
The waitlist offer reprice is the other deliberate exception: an offer re-bases
the whole booking at current rates before the member confirms, and the offer
email states that price. Legacy guests without stored night rows price at
current rates; a one-off backfill migration (#1098) synthesised rows for
pre-#713 guests on live, non-quote-priced bookings (stored price split evenly
across the stay envelope, integer cents, remainder on the first night), so
that fallback now covers only quote-priced bookings — already protected by
the #1032 edit block — and rows created outside the app.

Every edit path passes the default group discount into pricing exactly as
creation and the waitlist reprice do (#1095), and locks win over the discount:
a night a guest already bought keeps its locked (discount-inclusive) price, so
a party dropping below the minimum on removal never loses a discount it
bought, and the discount applies only to newly priced nights — a guest added
to a qualifying party, or nights a date change adds. Eligibility is per night
and per party size on that night: a partial-stay guest's absent nights do not
count toward the minimum. The modify-quote preview prices with the same
config so previews match what the mutating paths charge. The guest-add route
therefore prices the whole post-add party in one pass — the added guest's
stored price and night rows are their slice of the combined breakdown.

Every booking-reduction path — batch modify (`removeGuestIds`/date change),
single-guest removal (`DELETE …/guests/[guestId]`), and date change
(`modify-dates`) — returns member money limited by the same cancellation-policy
tier for the days until check-in, folding any change fee into the net delta, and
requires the member to elect a card refund or account credit whenever a captured
payment makes a settlement returnable. No reduction path refunds the full price
delta outside the policy. A request against a booking with a captured payment
that omits the settlement election is rejected rather than defaulted, so a
body-less self-removal cannot silently settle the booking owner's money; the
owner or an admin makes the election through the batch edit flow.

Every modification path also applies the same lifecycle transitions: a
PAYMENT_PENDING booking whose price drops to zero auto-pays with a zero-dollar
payment (superseding and cancelling any outstanding primary PaymentIntents so a
stale checkout tab cannot capture the pre-change amount), any *other* price
change supersedes pending primary intents stranded at the old amount (#1161 —
and belt-and-braces, both intent-issuing endpoints refuse to hand out a
client_secret whose amount no longer matches `finalPriceCents`, and the
Stripe webhook alerts admins before refusing a capture that mismatches the
booking's current total), and the non-member
hold is recalculated from the remaining guests (all-member bookings clear the
hold; bookings inside the hold window move PENDING → PAYMENT_PENDING). The same
change must produce the same booking state regardless of which endpoint made
it.

A booking left with only non-adults (YOUTH/CHILD/INFANT) requires admin
approval regardless of how it got there or whether it was already paid: every
edit path — including single-guest self-removal, which is never blocked for a
written justification — flags the booking (`adminReviewStatus: PENDING`, with
an automatic note on the removal path) so it lands in the admin review queue.
Review parking moves a booking to AWAITING_REVIEW only from the pre-payment
statuses (PENDING/PAYMENT_PENDING); a paid or confirmed booking is flagged in
place, and approving it clears the review without re-opening the payment
lifecycle. Rejection cancels through the shared cancellation flow, which
refunds captured payments per the policy.

A booking converted from (or held for) a public/school booking request keeps
its officer-negotiated price, flat-split across guest rows; the quote's
per-tier rates are not persisted on the booking. Before a school group
arrives, the school contact confirms who is attending (#1101): a tokenized
public page (hash-stored, rotated per reminder email) applies identity-only
name updates through the same price-preserving machinery as quoted-booking
edits, and the explicit confirmation is stored on the booking request.
Headcount or tier changes still go through the admin re-quote flow, and
unconfirmed lists inside the prompt window surface on the stuck-state
dashboard. Standard edit paths (batch
modify, date change, guest add, single-guest removal, and the modify-quote
preview) refuse such bookings rather than silently repricing every guest at
season rates — the change is made by re-pricing or issuing a revised quote
from the booking request. The one exception (#1099) is identity-only edits:
guest name fixes never run the pricing engine — stored totals, per-guest
prices, and night rows are echoed back unchanged on every booking, quoted or
not — so they pass the block, and quoted bookings are additionally exempt
from the paid-name lock (renaming placeholder students after the school has
paid its invoice is the intended workflow).

A price reduction against an issued-but-unpaid Xero invoice (pay-on-account,
no captured payment) is corrected for the full net delta — there is no captured
money and therefore no cancellation-policy tier to apply — via a modification
credit note against the primary invoice, which is never reissued. Consequently
the true outstanding balance on such an invoice is the current `finalPrice`
plus any billed change fee, i.e. the original total minus the modification
credit notes already issued. Cancellation must clear that true outstanding and
must not read the captured-amount mirror (`payment.amountCents`), which stays at
the original total until asynchronous Xero reconciliation folds the credit note
into `refundedAmountCents`.

The paid-path twin of that rule: cancellation of a booking with a captured
payment computes its refundable base as
`min(amountCents − refundedAmountCents, finalPrice + changeFee) − changeFee`,
never from the raw Payment mirror alone. Prior reductions can leave the mirror
stale (an Internet Banking invoice paid at its reduced amount, or a
penalty-window retention), and an uncapped base pays out more than the booking
is worth. The cancel preview applies the same cap so the member is never
promised more than the cancel will pay.

A credit-settled modification reduction allocates against the payment's
captured transactions (`applyLocalRefundAllocation`) in the same transaction
that writes the `MemberCredit`, exactly as a card-settled reduction does via
the refund ledger. `refundedAmountCents` therefore reflects every settlement
method, and no ordering of edit/cancel operations may produce a different
total payout (refunds plus credits) than another ordering reaching the same
final state.

Cancelled-booking soft-delete may hide an operational duplicate only when it
preserves the booking row and no external money/Xero history needs to remain
operator-visible by default. Balanced internal modification deltas that net to
zero are not external financial history by themselves.

## Analytics And Privacy

Google Analytics must not load unless all three hold: the Analytics module is
enabled, `NEXT_PUBLIC_GA_MEASUREMENT_ID` is configured, and the visitor has
explicitly accepted the consent banner. Declining or dismissing the banner
counts as denied, Google Consent Mode defaults every storage category to
denied until an explicit accept, and the stored per-browser choice
(`analytics-consent.v1`) is honoured on revisit.

## Membership Lifecycle

Membership application, nomination, cancellation, archive, delete, family, and
dependent changes must preserve financial history, booking and guest history,
audit history, required family/dependent history, privacy preferences, and Xero
contact/link history where required.

Access role, seasonal membership type, age tier, Xero contact-group rule, and
committee assignment are separate axes. `MemberAccessRole` controls application
access via the legacy enum values (`USER`, `ADMIN`, `ADMIN_READONLY`,
`ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`, `LODGE`,
`FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to a club-editable
`AccessRoleDefinition` (label, description, per-area permission matrix).
`ADMIN`, `LODGE`, `USER`, and `ORG` are protected system roles: code-defined,
never editable or deletable, and Full Admin always keeps full permissions.
Deleting a definition is blocked while any member holds it. Custom
definition-backed roles are privileged for the Full-Admin
separation-of-duties gate, exactly like the seeded bundles;
`Member.role` is limited to `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and
`SCHOOL`, and `financeAccessLevel` is a compatibility field. Neither field may
be used as a runtime permission gate or for new membership-category semantics.
Bundled and definition-backed rows are composed by the central admin
permission matrix (maximum level per area); they must not be projected into
legacy `Member.role = ADMIN`. Finance portal access derives from the merged
`finance` area level, never from the enum values or `financeAccessLevel`.
Legacy membership lifecycle/classification code may read `Member.role` only to
distinguish compatibility categories such as non-login/non-member records until
that workflow is fully represented by seasonal membership type.
`SeasonalMembershipAssignment` stores per-season membership policy, including
the source of the assignment and an optional date-only `applyFrom` changeover.
Age tiers remain separate because the same tier can be Full, Life, Associate,
Family, School, or another
configured type. Age-tier Xero groups and membership-type Xero groups may both
exist; duplicate exact rules and multiple managed rules for the same scope are
not valid. Committee assignment controls public committee/contact presentation
only. Do not add committee positions to access roles or `Member.role`.
`CommitteeRole` master records and `CommitteeAssignment` member links can be
active/inactive independently of access role and seasonal membership type, and
newly linked assignments are hidden until explicitly published by an admin.
Committee contact routing uses the role email alias stored on `CommitteeRole`,
falling back to the linked member's email only when the role email is blank.
Booking pricing, booking block checks, and effective subscription lockout may
depend on the member's seasonal membership type for the
booking season; application access and committee presentation must not.
Seasonal membership type changes require a guarded admin preview and reasoned
audit record. Existing future bookings are not automatically repriced by a type
change, and raw subscription, payment, and Xero history must remain intact even
when the effective subscription status is `NOT_REQUIRED`.

When the global two-factor module is enabled, password login is not sufficient
for protected app access. The Auth.js JWT must carry `twoFactorVerified=false`
until a server-side two-factor verification or enrollment endpoint flips it.
The Auth.js session-update trigger is reachable by any authenticated client
(POST `/api/auth/session`), so the jwt callback must never trust a
client-supplied `twoFactorVerified` flag. The claim flips only after the
callback consumes a single-use, short-lived challenge token minted server-side
by the verification and enrollment endpoints and stored hashed in
`TwoFactorSessionChallenge`. Route-group layouts and API guards must enforce
that claim; login form code must not be the only 2FA gate. TOTP secrets, email
OTP codes, recovery codes, and session challenge tokens must never be stored
in plaintext.

Pending nomination states must have an expiry, reminder, admin refresh,
replacement, rejection, or other documented recovery path so applications do
not remain permanently blocked by stale action links.

Lodge induction sign-off is a single overall Pass per signer. Checklist items
remain the reference material for the induction, but runtime sign-off does not
store per-item Yes/No/N/A results or member self-assessment levels. New-member
inductions created from approved applications should explicitly assign the
application nominators as signers while preserving the application nominator
fallback for historical records. Completing a Hut Leader Induction sets
`Member.hutLeaderEligible`; it does not create or date a `HutLeaderAssignment`,
which remains an admin-controlled roster/coverage record.

Hard delete must remain limited to records that pass the eligibility checks for
no durable booking, financial, family, Xero, or membership-history blockers.

## Integrations

- Webhooks and cron jobs must be idempotent.
- Provider callbacks must verify signatures, state, or expected origin before
  local mutation.
- External provider calls should not be placed inside long database
  transactions unless there is a documented reason.
- Email, Xero, and payment failures that affect business-critical outcomes must
  be visible and retryable.
- Logs, webhook records, Sentry events, and PR comments must not expose secrets,
  OAuth codes/states, action tokens, client secrets, or personal data beyond the
  minimum needed for diagnosis.

## Operations

- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.
- Public CI and local validation must use test/demo credentials or placeholders.
- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
