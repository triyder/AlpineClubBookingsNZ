# Feature Regressions

**Primary child issue**: #679
**Related issues**: #673, #680, #681
**Related PRs**: #685, #688, #690
**Status**: Closed

## Result

No unresolved critical or high feature-regression findings remain from this hardening pass.

## Booking Lifecycle and Per-Guest Dates

Issue #679 reviewed booking lifecycle, per-guest date flows, promos, draft booking, waitlist confirmation, force confirmation, and guest add/remove behavior.

The review confirmed:

- Per-guest date inputs are normalized to NZ date-only values before pricing/capacity.
- Booking modifications preserve explicit guest stay ranges and check active guest nights.
- In-progress completed booking edits are constrained to future nights.
- In-progress member attempts to change check-in are rejected.
- Promo calculations use per-guest nightly rates, including fixed-nightly and assigned/free-night behavior.
- Stripe and Internet Banking modification settlement branches remain separated.

No new #679 remediation PR was required.

## Per-Guest Capacity

Issue #673 was fixed by #685 and is included here because it directly supports the #679 acceptance criteria.

PR #685 replaced flat full-span guest-count capacity checks with `checkCapacityForGuestRanges` in:

- Final payment reconciliation.
- Draft payment-intent preflight.
- Saved-card confirmation.
- Admin force-confirm.
- Guest-add modification.
- Waitlist offer and confirmation paths.
- Pending-booking bump recovery.

## Bed Allocation

Issue #680 was fixed by #690.

The finding: lifecycle/admin auto-allocation planned only missing guest-nights. If an adult was already allocated and a related minor night was missing, the planner could fail to use that existing adult context.

The fix preserves existing allocation context when planning missing nights.

## Member CSV Import

Issue #681 was fixed by #688.

The hardening changes:

- Month-name date parsing now requires exact abbreviations or full month names.
- Failed preview validation keeps commit payloads empty.
- Imported members become login-enabled primary accounts where intended.
- Existing-email rows are skipped with row-level reporting in the API/UI.

## Validation Evidence

For #679:

- `npm ci`.
- `DATABASE_URL=postgresql://tac:password@localhost:5433/tacbookings npm run db:generate`.
- Targeted Vitest run passed: 7 files, 175 tests.

For #673/#680/#681:

- Focused capacity, payment, waitlist, bed-allocation, lifecycle, member CSV, API boundary, lint, TypeScript, Prisma, and diff checks were run in their respective PRs.

The final baseline also passed the full local test suite before this report.

## Feature Conclusion

The newly merged booking, bed allocation, CSV import, promo, and payment-option features have targeted regression coverage for the reviewed risk paths. No critical/high feature regression remains known.

