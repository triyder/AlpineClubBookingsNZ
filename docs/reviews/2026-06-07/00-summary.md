# 24-hour hardening final synthesis

**Review date**: 2026-06-07
**Repository**: `thatskiff33/AlpineClubBookingsNZ`
**Final reviewed main commit before this report**: `b72f0ae`
**Parent epic**: #674
**Final synthesis issue**: #683

## Scope

This synthesis covers the 24-hour hardening epic for merged work through #644, #645, and #659-#672, plus remediation and verification PRs merged during the hardening pass:

| Area | Issue | Outcome |
| --- | ---: | --- |
| Security and API boundaries | #675 | Fixed malformed JSON handling in changed API routes via #689. |
| Stripe/payment state | #676 | Fixed Internet Banking vs Stripe payment-source integrity and stale additional-intent cleanup via #684. |
| Xero accounting | #677 | Fixed Internet Banking invoice settlement and recoverable partial credit-note handling via #686. |
| Booking reductions/credits | #678 | Fixed partially refunded settlement handling, credit idempotency, and stale settlement input via #687. |
| Booking feature regressions | #679 | Reviewed and validated; no new remediation PR required. |
| Bed allocation | #680 | Fixed family auto-allocation context for partially allocated bookings via #690. |
| Member CSV import | #681 | Hardened date parsing, empty failed-preview payloads, and import skip reporting via #688. |
| Schema, dependencies, CI | #682 | Fixed Next.js/Turbopack root inference warning via #691. |

Related per-guest capacity issue #673 was also fixed by #685 and is included because it directly supports #679 acceptance.

## Original Feature Window

The original implementation window included these PRs:

- #644 dependency minor/patch group update.
- #645 `xero-node` 18 update.
- #659 module flags for bed allocation and bank payments.
- #660 bed allocation schema/service layer.
- #661 FIFO bed allocation family rules.
- #662 admin bed allocation management.
- #663 booking lifecycle bed allocation integration.
- #664 fixed nightly promo codes.
- #665 per-guest dates in the live booking flow.
- #666 removal of obsolete Xero MCP Caddy route.
- #667 per-guest booking date modifications.
- #668 payment source foundation.
- #669 Internet Banking Xero invoice payment flow.
- #670 member CSV import wizard.
- #671 member CSV mapping and date-format import.
- #672 booking reduction refund/member-credit choice.

## Final Status

All child issues #675-#682 are closed. Remediation PRs #684-#691 are merged. No unresolved critical or high findings are known from this hardening pass.

The most important fixes were:

- Prevented Internet Banking bookings from entering Stripe-only PaymentIntent/refund paths.
- Prevented settled Internet Banking invoices from being posted as Stripe-bank payments in Xero.
- Preserved recoverable Xero `PARTIAL` state when credit-note allocation fails.
- Capped reductions to remaining refundable balances and made modification-generated member credits idempotent.
- Centralized malformed JSON handling for changed API routes.
- Fixed bed allocation planning when family adults are already allocated.
- Pinned Turbopack root to this repository for predictable Next.js 16 builds.

## Validation

Local validation for #682 and the final baseline used Node 24/npm 11 via `npm exec` wrappers, with local dummy/non-live environment values:

- `npm ci`
- `npm audit --audit-level=high --package-lock-only`
- `npm run lint`
- `npm run db:generate`
- `DATABASE_URL=postgresql://tac:password@localhost:5433/tacbookings npx prisma validate`
- `npm test`
- `npm run build`
- `git diff --check`

Full test result recorded before this report: 277 files passed, 1 skipped; 2988 tests passed, 1 skipped.

GitHub Actions results observed before this report:

- PR #691 checks passed, including verify, static analysis, gitleaks, CodeQL, and Docker image security.
- The Docker image security job passed the CRITICAL gate and the HIGH warning scan reported clean package targets in the inspected summary.
- Closure of #674/#683 requires the final docs PR checks and post-merge `main` checks to be green.

## Files

- `00-summary.md` - this summary.
- `01-security.md` - API boundary and security review synthesis.
- `02-stripe-payments.md` - Stripe and payment-state synthesis.
- `03-xero-accounting.md` - Xero invoice, credit, outbox, and reconciliation synthesis.
- `04-feature-regressions.md` - booking, bed allocation, CSV, and feature regression synthesis.
- `05-schema-ci.md` - schema, migration, dependency, Next.js, and CI synthesis.
- `06-residual-risks.md` - remaining operational risks and go-live notes.
