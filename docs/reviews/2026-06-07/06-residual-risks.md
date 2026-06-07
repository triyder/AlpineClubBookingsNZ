# Residual Risks

This file lists known residual risks after the 2026-06-07 hardening pass. None are currently classified as unresolved critical or high code findings from #675-#682.

## Operational Risks

- **No live-provider testing in this pass**: Stripe, Xero, SES, Sentry, and production database credentials were not used. This follows AGENTS.md. Live provider verification should happen only in a written test window.
- **No production endpoint scanning**: Browser automation, DAST, load tests, and broad endpoint scanning were not run against production.
- **GitHub CI remains the external source of truth**: Local validation passed, and PR #691 CI passed. #683/#674 closure requires the final docs PR and post-merge `main` checks to be green.
- **Docker HIGH scan policy is warning-level**: The workflow fails on CRITICAL image vulnerabilities and warns on HIGH. The inspected PR #691 Docker log showed clean scanned package targets for the HIGH warning step, but the policy remains warn-only by design.
- **Host runtime differs from repo engines by default**: The host default shell is Node 22/npm 10. Final validation used Node 24/npm 11 through `npm exec` wrappers to match the repo contract.

## Product Risks

- **Internet Banking relies on Xero reconciliation**: This is the intended design after #684/#686, but operational procedures must continue monitoring unmatched or stale Xero invoice/payment states.
- **Xero partial credit-note repair remains asynchronous**: PR #686 preserves recoverable `PARTIAL` state, but operators still need retry/repair visibility for stuck outbox operations.
- **Booking modification service remains large**: The hardening pass fixed correctness issues but did not refactor the batch modification service. Future changes should keep adding focused tests around settlement, guest ranges, and in-progress edits.
- **Feature review was targeted, not exhaustive UI testing**: #679 covered the requested risk paths with source review and targeted tests. It did not replace manual UAT for the full booking interface.

## Release Readiness Notes

Before go-live or private deployment sync:

- Confirm the final #683 PR checks are green.
- Confirm post-merge `main` CI is green, including Docker image security.
- Keep live Stripe/Xero verification in a written test window.
- Monitor Xero outbox/reconciliation queues after any real Internet Banking payment flow test.
- Preserve integer cents and NZ date-only semantics in future changes.
