# Issue #814 High-Risk Invariant Test Gap Review

Date: 2026-06-20

Mode: review-only planning task. No application code was edited, no live
providers or production data were used, no full test suite or browser
automation was run, and no follow-up GitHub issues were created.

## Scope Reviewed

Reviewed the existing static and unit/integration-style test surface for the
highest-risk invariants called out in `docs/DOMAIN_INVARIANTS.md` and
`docs/END_TO_END_TEST_MATRIX.md`:

- NZ date-only booking nights, per-guest stay ranges, capacity, waitlist, and
  bed allocation.
- Integer-cent payment, refund, credit, Stripe, Internet Banking/Xero, and
  accounting consistency.
- Membership application, nomination, family/dependent, cancellation,
  archive/delete, and durable-history blockers.
- Cron/recovery jobs, provider callbacks, webhook replay/idempotency, and admin
  health visibility.
- Prior review findings from issues #812 and #813 where the next action is
  targeted test coverage rather than immediate app-code change.

## Files/Directories Inspected

Required policy and context:

- `AGENTS.md`
- `README.md`
- `CONFIGURATION.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/agents/CODEX_WORKFLOW.md`
- `docs/agents/ISSUE_WORKFLOW.md`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/STATE_MACHINES.md`
- `docs/END_TO_END_TEST_MATRIX.md`
- `docs/UX_FLOW_MAP.md`
- `docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md`
- `docs/reviews/2026-06-20/ISSUE_CREATION_PLAN.md`
- `docs/reviews/2026-06-20/issue-812-security-route-boundary-review.md`
- `docs/reviews/2026-06-20/issue-813-lifecycle-state-machine-review.md`
- `package.json`

Targeted implementation/test files:

- `src/lib/booking-status.ts`
- `src/lib/bed-allocation-lifecycle.ts`
- `src/app/api/bookings/[id]/guests/[guestId]/route.ts`
- `src/app/api/admin/refund-requests/[id]/route.ts`
- `src/lib/nomination.ts`
- `src/app/api/admin/member-applications/[id]/route.ts`
- `src/app/api/cron/route.ts`
- `src/app/api/cron/payments/route.ts`
- `src/instrumentation.node.ts`
- `src/lib/cron-job-run.ts`
- `src/lib/stripe-webhook-service.ts`
- `src/app/api/webhooks/ses-sns/route.ts`
- `src/app/api/webhooks/xero/route.ts`
- `src/lib/__tests__/capacity.test.ts`
- `src/lib/__tests__/bed-allocation.test.ts`
- `src/lib/__tests__/bed-allocation-lifecycle.test.ts`
- `src/lib/__tests__/admin-bed-allocation.test.ts`
- `src/lib/__tests__/waitlist.test.ts`
- `src/lib/__tests__/payment-reconciliation.test.ts`
- `src/lib/__tests__/payment-transactions-refunds.test.ts`
- `src/lib/__tests__/payment-recovery.test.ts`
- `src/lib/__tests__/booking-guest-removal-service.test.ts`
- `src/lib/__tests__/admin-refund-request-review-route.test.ts`
- `src/lib/__tests__/member-credit.test.ts`
- `src/lib/policies/__tests__/member-credit-rules.test.ts`
- `src/lib/__tests__/membership-nomination.test.ts`
- `src/lib/__tests__/admin-member-applications-route.test.ts`
- `src/lib/__tests__/membership-cancellation-requests.test.ts`
- `src/lib/__tests__/membership-cancellation-admin.test.ts`
- `src/lib/__tests__/membership-cancellation-blockers.test.ts`
- `src/lib/__tests__/membership-cancellation-xero.test.ts`
- `src/lib/__tests__/member-lifecycle-actions.test.ts`
- `src/lib/__tests__/family-groups.test.ts`
- `src/lib/__tests__/family-child-request.test.ts`
- `src/lib/__tests__/family-invite.test.ts`
- `src/lib/__tests__/cron-confirm-pending.test.ts`
- `src/lib/__tests__/cron-payments.test.ts`
- `src/lib/__tests__/admin-cron-health.test.ts`
- `src/lib/__tests__/feature-cron.test.ts`
- `src/lib/__tests__/stripe-webhook-alerts.test.ts`
- `src/lib/__tests__/xero-webhook-route.test.ts`
- `src/lib/__tests__/ses-sns-webhook.test.ts`
- `src/lib/__tests__/xero-operation-outbox.test.ts`
- `src/lib/__tests__/xero-operation-retry.test.ts`
- `src/lib/__tests__/xero-inbound-reconciliation.test.ts`

## Current Coverage Observed

- Capacity and date-only coverage is relatively strong. `capacity.test.ts`,
  `payment-reconciliation.test.ts`, and `multi-date-range-stays.test.ts` cover
  date-only boundaries, completed bookings as capacity-holding, and per-guest
  stay ranges.
- Waitlist coverage is broad. `waitlist.test.ts` covers FIFO position,
  promotion, partial capacity rejection, per-guest stay ranges, offer
  confirmation, expired offers, owner checks, capacity races, module-disabled
  cron skips, and past-date auto-cancel.
- Bed allocation coverage is broad for planning, family/minor constraints,
  manual allocation conflicts, inactive beds, date-only allocation ranges,
  feature gating, and pruning stale guest-night allocations.
- Payment recovery coverage is strong for superseded PaymentIntent
  cancellation, already-cancelled intents, retry exhaustion, stale processing,
  succeeded superseded intents, booking-modification refund recovery, duplicate
  refund replay, and admin alerting.
- Payment/refund ledger coverage verifies first-class `PaymentRefund` rows,
  Stripe refund idempotency, webhook refund upsert, zero-dollar payment
  preservation, and Internet Banking transactions staying out of Stripe refund
  APIs.
- Member credit coverage is strong around integer cents, idempotent admin
  adjustment replays, audit rollback, self-approval rejection, and concurrent
  negative approval balance protection.
- Membership cancellation coverage includes request creation, hashed token
  confirmation, concurrent confirmation claims, token reissue, email-warning
  behavior, admin approval blockers for future owned bookings and guest
  appearances, self-approval rejection, and Xero cancellation operations.
- Member archive/delete coverage includes blocker detection, independent admin
  approval, snapshot/hard-delete behavior, legacy direct delete blocking,
  archive claim conflict, and operational link cleanup audit metadata.
- Provider callback coverage exists for Stripe, Xero, and SES/SNS signature or
  authenticity rejection, oversized/malformed payload rejection, dedupe for Xero
  inbound reconciliation and SES/SNS notifications, Stripe refund delta
  idempotency, stale Stripe intent handling, and provider error redaction.
- Cron/recovery visibility coverage exists for payment cron route recording,
  confirm-pending service behavior, feature-aware cron registration, and admin
  cron-health classification.

## Missing Or Weak High-Risk Tests

1. Bed allocation and capacity status ownership need a cross-invariant contract
   test. `CAPACITY_HOLDING_BOOKING_STATUSES` intentionally excludes `PENDING`,
   `PAYMENT_PENDING`, and `WAITLIST_OFFERED`, while
   `BED_ALLOCATABLE_BOOKING_STATUSES` includes them. Existing tests confirm
   completed bookings are allocatable and capacity-holding, but do not lock the
   intended relationship between non-capacity-holding allocation rows and
   booking-capacity decisions. Follow-up should prove whether provisional/offered
   allocation is operator pre-assignment only, and what happens when a paid or
   awaiting-review booking competes for the same bed/night.

2. Legacy guest-removal refund failure lacks a route-level recovery or
   visibility test. `booking-guest-removal-service.test.ts` covers refund amount
   calculation, but the active DELETE route catches `refundPaymentTransactions`
   failure, logs "requires manual reconciliation", and still returns the local
   booking mutation. There is no targeted test proving a durable recovery row,
   admin-visible repair state, or explicitly accepted manual-reconciliation
   contract for that failure mode.

3. Refund appeal approval needs concurrency and local-failure tests around the
   money side effect. The admin refund-request route has a happy-path test that
   verifies the Stripe refund helper and Xero credit-note queueing. It does not
   test two admins approving the same request concurrently, the `updateMany`
   claim losing after the Stripe refund helper succeeds, audit/email failures
   after approval, or idempotent replay of the same refund request. Because the
   route performs refund work before the local claim, this deserves a focused
   high-risk follow-up.

4. Stale `PENDING_NOMINATORS` application behavior is only partially covered.
   `membership-nomination.test.ts` verifies expired token rejection and duplicate
   pending-application rejection, but this review did not find tests for the
   operator/member recovery path when all nomination tokens expire and the
   application remains `PENDING_NOMINATORS`. Admin application route coverage is
   currently list-only for the queue boundary, not reissue/reject/expiry
   recovery.

5. Cron run recording is covered unevenly between HTTP-triggered cron routes and
   in-process scheduled jobs. `cron-payments.test.ts` verifies the payment cron
   route writes `CronJobRun`, and `admin-cron-health.test.ts` checks health
   classification/definitions. The many `instrumentation.node.ts` scheduled
   jobs write `CronJobRun` through a nested helper, but there is no direct
   contract test proving every business-critical registered job records
   `SUCCESS`, `FAILURE`, and module-disabled `SKIPPED` outcomes and appears in
   admin health with the same job name.

6. Stripe webhook processed-event replay coverage is weaker than SES/SNS and
   Xero. `stripe-webhook-service.ts` short-circuits duplicate
   `processedWebhookEvent.create` `P2002` errors, and Stripe tests cover many
   state-specific idempotency cases. This review did not find a focused route
   test that forces a duplicate Stripe event claim and asserts no downstream
   payment, Xero, or notification side effects run. SES/SNS has that exact
   duplicate-notification route test, and Xero inbound reconciliation has
   duplicate event processing tests.

7. Booking-event/audit/status transition coverage is not systematic. Prior
   lifecycle review found that `BookingEvent` is a narrative subset rather than
   a full transition ledger. Existing tests cover `booking-narrative`,
   `booking-history`, waitlist state, cancellation, and payment state in
   separate places, but this review did not find one contract test that defines
   which high-risk transitions must produce `BookingEvent`, which must produce
   audit only, and which are intentionally status/CronJobRun-only.

8. Provider-callback and payment tests are broad but still source-specific.
   There are strong Stripe and Xero tests, plus Internet Banking separation
   tests, but follow-up issues should avoid relying on one source's happy-path
   test to prove the other source's invariant. The highest-risk examples are
   refund/credit reconciliation, modification credit notes, and additional
   payment settlement where Stripe, Internet Banking/Xero, member-credit, and
   Xero outbox state must not cross-contaminate.

## Proposed Follow-up Test Issues

These are candidate issue scopes only. No issues were created.

1. Add bed-allocation/capacity status ownership tests for `PENDING`,
   `PAYMENT_PENDING`, and `WAITLIST_OFFERED` allocation rows competing with
   capacity-holding bookings.
2. Add route/service tests for guest-removal refund failure that assert durable
   recovery/admin visibility, or document and test the explicit manual
   reconciliation contract if that is the intended behavior.
3. Add refund-request approval tests for concurrent approval, claim-lost after
   refund helper success, retry/idempotency behavior, and audit/email/Xero queue
   failure handling.
4. Add membership-application stale nomination recovery tests for expired
   tokens, duplicate applicant submission after expiry, admin rejection or
   reissue behavior, and admin queue visibility.
5. Extract or expose a cron registration/recording contract and test that every
   high-risk scheduled job writes `CronJobRun` and maps to admin cron-health
   definitions with matching names and freshness thresholds.
6. Add a duplicate Stripe webhook event route test that simulates `P2002` on
   processed-event creation and asserts no downstream mutation or provider
   queueing runs.
7. Add booking transition ledger contract tests that define expected
   `BookingEvent`, audit-log, and CronJobRun coverage for admin review approval,
   force-confirm, waitlist offer/expiry/confirmation, complete-bookings, and
   payment recovery transitions.
8. Add source-separation matrix tests for refund/credit/modification settlement
   across Stripe, Internet Banking/Xero, member-credit, and Xero outbox paths.

## Suggested Validation Commands For Follow-ups

Keep follow-up validation targeted and mocked:

- `npm run lint`
- `git diff --check`
- `npx vitest run src/lib/__tests__/capacity.test.ts src/lib/__tests__/bed-allocation-lifecycle.test.ts src/lib/__tests__/admin-bed-allocation.test.ts`
- `npx vitest run src/lib/__tests__/booking-guest-removal-service.test.ts src/lib/__tests__/payment-recovery.test.ts`
- `npx vitest run src/lib/__tests__/admin-refund-request-review-route.test.ts src/lib/__tests__/payment-transactions-refunds.test.ts`
- `npx vitest run src/lib/__tests__/membership-nomination.test.ts src/lib/__tests__/admin-member-applications-route.test.ts`
- `npx vitest run src/lib/__tests__/cron-payments.test.ts src/lib/__tests__/admin-cron-health.test.ts src/lib/__tests__/feature-cron.test.ts`
- `npx vitest run src/lib/__tests__/stripe-webhook-alerts.test.ts src/lib/__tests__/ses-sns-webhook.test.ts src/lib/__tests__/xero-webhook-route.test.ts`
- `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate` for follow-ups touching Prisma schema assumptions.

Do not use live Stripe, Xero, SES/SNS, production credentials, production data,
live webhooks, broad endpoint scanning, browser automation against production,
or production `CRON_SECRET` for these follow-ups.

## Uncertainty/To-Verify List

- Whether provisional/offered bed allocation is intended to reserve operator
  placement only, and whether confirmed/paid bookings should be able to
  override or displace those allocations.
- Whether the legacy guest-removal route remains user-facing for normal booking
  edits or is compatibility-only.
- Whether refund-request approval should claim a local processing state before
  the Stripe refund helper, or whether existing Stripe idempotency is considered
  enough with a targeted retry test.
- Whether stale `PENDING_NOMINATORS` applications should expire automatically,
  remain admin-recoverable, or allow a fresh applicant submission after all
  tokens expire.
- Whether `instrumentation.node.ts` scheduled-job recording should be tested by
  extracting the registration/recording map rather than importing the runtime
  module directly.
- Whether `BookingEvent` should be documented as a narrative ledger only, and
  which transitions must instead be asserted through audit logs or CronJobRun.
