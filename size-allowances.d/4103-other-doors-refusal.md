# File-size allowances for #4103 — no other card refund door closes, or says "refunded", on a refusal

The rule lives in `src/lib/refused-card-refund-retry.ts` (one helper for every
door whose recovery row predates its attempt, `keepRefusedPrePersistedRefundOwed`),
the late-capture hold in `src/lib/late-capture-refund-hold.ts`, and the edit
review's card refund moved whole into `src/lib/edit-financial-review-card-refund.ts`.
What each file below gains is the one call its own refund makes to that rule,
in the function that already owns the refund. Comments were cut to one or two
lines first.

file: src/lib/payment-reconciliation.ts
lines: 3175
reason: the duplicate-capture and capacity-race refunds each gain a one-line
  closure over the shared re-plan, a refusal check after the attempt and a
  guard so the door's existing failure alert is the refusal's only alert; the
  capacity race, whose plan can span charges, also re-plans in its catch for a
  slice refused before a throw. Both refunds live inside
  `markBookingPaymentSucceeded`'s post-commit tail; lifting either out is a
  refactor of that function, not this fix.

file: src/lib/payment-recovery.ts
lines: 3481
reason: the superseded-payment refund processor routes its one Stripe call
  through `refundPlanOrRetryRefusals`, keeping its legacy first key and sending
  a moved slice through `refundPaymentTransactions` after a refusal. The call
  and its callback belong in the processor that owns the row. The ledger
  refund enqueue keeps a plan a refusal moved (review C2): a read and a
  compare-and-set fence in the one function every pre-persisted door enqueues
  through.

file: src/lib/group-cancel.ts
lines: 974
reason: the legacy group settlement refund, inline and in the replay, fails on
  a refusal as on a throw: one line each, a one- or two-line comment, and two
  imports; the replay's key moves past Stripe's recorded refusals
  (`keyAfterStripeRefusals`, review C3), four lines in the call.

file: src/lib/stripe-webhook-service.ts
lines: 1866
reason: each late-capture handler gains one line handing a refused refund to
  the hold (`holdLateCaptureRefusedByStripe`), the primary one also noting a
  slice made beside the refusal; the superseded group intent's refund a
  refusal check, its key moved past Stripe's recorded refusals and one alert
  per refusal (review C3, d); and two imports.

file: src/lib/booking-cancel.ts
lines: 2865
reason: the cancellation's call moves to the generalised helper, which needs
  the row's key spelled out (four lines where there were three, and one import),
  and its catch re-plans a refusal that came before a throw (two lines, review
  g).

file: src/lib/payment-transactions.ts
lines: 1580
reason: `PartialRefundError.refunds` names the status and slice each answer
  already carries (review f), so the repair pass reads them typed instead of
  through a cast. Three lines on the error's own type.
