# Stripe and Payment State

**Primary child issue**: #676
**Related issue**: #678
**Remediation PRs**: #684, #687
**Status**: Closed

## Result

No unresolved critical or high Stripe/payment-state findings remain from this hardening pass.

## Findings Fixed

### Internet Banking Entering Stripe Paths

PR #684 fixed a high-risk payment-source boundary issue. Bookings already in the Internet Banking payment flow could be routed into Stripe-only direct PaymentIntent creation, refund, or recovery paths.

The fix:

- Blocks Stripe PaymentIntent creation for bookings already awaiting Internet Banking payment.
- Keeps settled Internet Banking booking modifications out of Stripe refund recovery.
- Preserves Xero invoice settlement amounts for Internet Banking paths.
- Queues superseded additional PaymentIntent cancellations when guest-add modifications create a newer additional intent.

### Partially Refunded Payment Settlement

PR #687 fixed reduction settlement handling for partially refunded captured Stripe payments.

The fix:

- Treats partially refunded captured payments as settled for later reductions.
- Caps card refunds and account credits at the remaining refundable balance.
- Ignores stale `settlementMethod` input when policy returns no refundable or credit value.
- Adds a unique source modification constraint so generated member credits are idempotent under retry/replay.

## Confirmed Good

- Payment amounts remain integer cents.
- Stripe writes stay outside long database transactions where the surrounding workflow allows it.
- Failed Stripe refund calls enqueue recovery instead of silently losing the refund intent.
- Zero-dollar and superseded PaymentIntent cleanup paths remain covered by tests.
- Internet Banking payment settlement stays outside Stripe and is reconciled through the Xero invoice/inbound path.

## Validation Evidence

PR #684 validation included targeted payment transaction, recovery, webhook, modification, and draft/payment-intent tests, then full local `npm test` and `npm run build`.

PR #687 validation included booking modification, Xero settlement, outbox, member credit, Prisma validate, lint, TypeScript, and diff checks.

The final local full-suite result before this report was 277 files passed, 1 skipped; 2988 tests passed, 1 skipped.

## Payment Conclusion

The critical/high Stripe-payment issues identified in the hardening pass have been fixed and merged. Remaining payment risk is operational: do not use live Stripe credentials for exploratory testing, and verify real provider behavior only in a written test window.

