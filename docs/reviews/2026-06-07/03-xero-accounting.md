# Xero Accounting

**Primary child issue**: #677
**Related issues**: #676, #678
**Remediation PRs**: #684, #686, #687
**Status**: Closed

## Result

No unresolved critical or high Xero/accounting findings remain from this hardening pass.

## Findings Fixed

### Internet Banking Posted as Stripe Bank Payment

PR #686 fixed a high-risk accounting issue where `createXeroInvoiceForBooking` could record a Xero payment for any locally `SUCCEEDED` payment, regardless of payment source. A settled Internet Banking booking could therefore be posted as a Stripe-bank payment.

The fix keeps Internet Banking invoice settlement on the Xero inbound reconciliation path.

### Partial Credit Note State Overwritten

PR #686 fixed a second high-risk Xero issue where modification credit-note creation could create and link the Xero credit note, fail allocation, mark the operation `PARTIAL`, then throw into the outer failure handler and risk overwriting that recoverable partial state.

The fix preserves `PARTIAL` so the existing allocation retry path can repair the gap.

### Modification Settlement Integrity

PR #687 fixed Xero-facing settlement issues:

- Partially refunded payment reductions now produce settlement options correctly.
- Card refund and account-credit values are capped to remaining refundable balance.
- Modification-generated member credits are idempotent.
- Xero settlement operations distinguish card refund credit notes from account-credit credit notes.

## Confirmed Good

- Xero writes are queued through the outbox instead of performed deep inside long booking transactions.
- Internet Banking bookings can still email/link invoices while payment matching remains in Xero reconciliation.
- Supplementary invoices wait for confirmed additional Stripe payment where required.
- Credit-note partial failure paths are recoverable through existing outbox retry/repair flows.

## Validation Evidence

PR #686 validation included:

- Xero booking invoice tests.
- Xero inbound reconciliation tests.
- Xero booking edit settlement tests.
- Xero operation outbox and payload tests.
- Xero booking repair tests.
- Full local `npm test` and `npm run build`.

PR #687 added settlement/member-credit tests and schema validation for the idempotency constraint.

## Xero Conclusion

The hardening pass closed the critical/high Xero accounting gaps found in the 24-hour change window. Remaining Xero risk is provider/operations oriented: live tenant behavior was not exercised in this pass, and any live reconciliation testing should use an explicit written test window.

