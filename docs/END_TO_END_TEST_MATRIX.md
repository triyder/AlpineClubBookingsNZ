# End To End Test Matrix

This first-pass matrix links personas, journeys, risks, test types, and likely
validation commands. Use it to plan focused issues and avoid claiming coverage
that does not exist yet.

The Critical rows marked "Playwright E2E" below now have automated browser
coverage in `e2e/` run against the staging compose stack — see
[`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md). The Stripe payment specs skip unless
genuine Stripe test-mode keys are configured.

| Area | Persona or actor | Journey or behavior | Risk | Test type | Suggested validation |
| --- | --- | --- | --- | --- | --- |
| Auth/access control | Anonymous | Public pages, login, token routes, public API exceptions | High | Route/static tests plus manual public smoke | Locate and run targeted route/security suites |
| Auth/access control | Member/admin/finance/lodge | Global two-factor enforcement: enrollment, authenticator app, email code, recovery code, lockout, and protected-route/API gating | Critical | Auth service, route, guard, and manual login-flow tests | Targeted two-factor, session-guard, module, and auth-flow tests; Playwright E2E `e2e/two-factor-login.spec.ts` (TOTP enrollment, verify, recovery, gating); manual browser check for email-code enrollment |
| Auth/access control | Anonymous | Optional public Addy address-autocomplete proxy is unavailable when its module is off and manual entry still works | High | Feature-route/proxy tests plus address component fallback tests | Targeted feature-route, proxy, public endpoint, and address component tests; no live Addy calls |
| Privacy/analytics | Anonymous visitor | Google Analytics remains off until the admin Analytics module is enabled, a GA4 measurement id is configured, and the visitor accepts the consent banner | Medium | Component, CSP, module-readiness, and manual browser/network checks | Targeted analytics consent, Admin Modules, CSP tests; manual public website and public account-page check for no GA calls before consent and collect calls only after accept |
| Auth/access control | Member | Member cannot access other member booking/family/payment data | High | API route tests and service ownership tests | Targeted Vitest route/service suites |
| Auth/access control | Admin/finance/lodge | Role boundaries for full admin, read-only admin, booking office, membership officer, Treasurer, content manager, finance viewer, and lodge kiosk | High | Permission-matrix, API route, page guard, and navigation tests | Targeted admin-permissions, session-guard, access-role UI, finance-auth, and sidebar/nav tests; manual role checks on staging |
| Booking/capacity | Member | Create booking with capacity lock and per-guest stay ranges | Critical | Service tests, concurrency tests, manual booking flow | Targeted booking/capacity suites; Playwright E2E `e2e/booking.spec.ts` (`/book` journey, payment-owed booking holds no bed per #737, duplicate member-night block) and `e2e/stripe-payment.spec.ts` (paid booking occupies its beds) |
| Booking/capacity | Member | Prevent the same linked member from being booked on the same lodge night in multiple live bookings, with open-existing-booking and future self-removal recovery paths | High | Service, route, and booking-flow UI tests | Targeted member-night conflict helper, booking quote/create, and guest-removal route tests; manual `/book` duplicate-member flow |
| Booking/capacity | Member/admin | Waitlist, offer expiry, force-confirm, bump/cancel | High | Service tests and cron tests | Targeted waitlist tests plus safe cron unit tests |
| Payment/refund/credit | Member/admin | Stripe payment success/failure, saved card, refund, member credit | Critical | Unit/service tests with Stripe mocked | Targeted payment, refund, credit suites; Playwright E2E `e2e/stripe-payment.spec.ts` (test-mode success/decline; skips without test-mode keys) |
| Payment/refund/credit | Member/admin | Internet Banking/Xero invoice settlement distinct from Stripe | Critical | Service tests with Xero mocked | Targeted Xero booking invoice/reconciliation tests |
| Webhook replay/idempotency | Stripe/Xero/SES | Valid, duplicate, malformed, oversized, and wrong-signature payloads | Critical | Route tests with fake signed payloads | Targeted webhook route tests, no live provider calls |
| Cron rerun/recovery | Scheduler | Payment recovery, pending confirmation, waitlist, Xero retry, email retry | High | Unit/route tests with local DB or mocks | Targeted cron tests; never use production `CRON_SECRET` |
| Membership lifecycle | Applicant/member/admin | Application, nomination reminders, admin refresh/replacement, approval, cancellation, archive, delete | High | Service tests, cron tests, and admin route tests | Targeted membership/lifecycle suites |
| Membership lifecycle | Admin/member | Configure seasonal membership types with allowed age tiers and Xero group rules, assign member seasonal types with apply-from date plus guarded preview/reason/audit, roll assignments forward, enforce booking rate/block policy, and surface effective subscription status without losing raw history | High | Schema, migration/backfill, admin route, service, pricing, booking gate, and navigation tests | Targeted membership type seed/API/sidebar/member-assignment suites plus membership-type policy, Xero rule validation, booking quote/create/modify, group join, and subscription-status tests |
| Committee administration | Admin/member/public | Configure committee master roles with role email aliases, link members to roles, edit hidden-by-default assignment presentation flags, and publish privacy-controlled committee/contact records that do not expose member email addresses publicly and route contact mail to role email before member-email fallback | High | Schema, migration/backfill, admin route, member detail, seed, audit, public API, contact route, and component tests | Targeted committee role/assignment API tests, seed defaults, member detail integration, public committee privacy tests, contact routing fallback tests, and public committee/contact component tests |
| Family/dependents | Member/admin | Adult invitations, dependents, inherited email, age-up | High | Service tests and UI route tests | Targeted family/dependent tests |
| Xero/SES failure | Admin/operator | Xero outbox failure/retry, SES suppression/failure visibility | High | Service tests with provider mocks | Targeted Xero outbox/email retry tests |
| UI/UX journey | Admin | Long admin form save feedback scrolls the admin scroll container or dialog body to top on success, and focuses the first top error banner on validation failure | Low | Hook unit tests plus manual admin form checks | Targeted `use-scroll-to-feedback` Vitest; manual member-dialog validation and success checks |
| UI/UX journey | Admin/finance operator | Open the shell-level help icon on Admin and Finance pages and read route-specific guidance for common actions, key fields, and complex sections | Low | Registry unit tests plus component dialog tests | Targeted contextual-help registry/button tests plus manual `/admin/members`, `/admin/xero/setup`, and `/finance` smoke |
| UI/UX journey | Admin/visitor | Edit shared site footer content from Admin > Site Content and render the sanitised, token-resolved columns on public website pages | Medium | API, migration/backfill, component, and manual public footer checks | Targeted site-content API/backfill/footer tests plus `/admin/site-content` and public footer smoke |
| UI/UX journey | Admin/visitor | Publish site-wide notice banners with priority colour, inclusive NZ date-only display windows, per-browser dismissal, and edit-triggered re-display | Medium | API, service, component, and manual public/member header checks | Targeted site-banner API/service/component tests plus `/admin/site-banners` and public/member header smoke |
| UI/UX journey | Visitor/member/admin | Happy path and empty/failure/pending states | Medium | Component tests plus manual staging checks | `npm run lint`, targeted component tests, staging route checklist |
| Accessibility | Visitor/member/admin/lodge | Keyboard, headings, labels, contrast, focus, touch targets | Medium | Manual staging and Lighthouse on non-production | See `docs/STAGING_ACCESSIBILITY.md` |
| Operations/deploy | Maintainer/operator | Migration safety, blue/green compatibility, CI gates | High | Script tests and dry-run validation | `git diff --check`, migration safety scripts on non-production data |

## Baseline Safe Checks

```bash
git diff --check
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npx tsc --noEmit
npm test
```

Do not run browser automation, load tests, DAST, live provider calls, or
production-like endpoint scanning against production without a written test
window.
