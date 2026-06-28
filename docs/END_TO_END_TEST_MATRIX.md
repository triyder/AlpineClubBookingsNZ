# End To End Test Matrix

This first-pass matrix links personas, journeys, risks, test types, and likely
validation commands. Use it to plan focused issues and avoid claiming coverage
that does not exist yet.

| Area | Persona or actor | Journey or behavior | Risk | Test type | Suggested validation |
| --- | --- | --- | --- | --- | --- |
| Auth/access control | Anonymous | Public pages, login, token routes, public API exceptions | High | Route/static tests plus manual public smoke | Locate and run targeted route/security suites |
| Auth/access control | Anonymous | Optional public Addy address-autocomplete proxy is unavailable when its module is off and manual entry still works | High | Feature-route/proxy tests plus address component fallback tests | Targeted feature-route, proxy, public endpoint, and address component tests; no live Addy calls |
| Auth/access control | Member | Member cannot access other member booking/family/payment data | High | API route tests and service ownership tests | Targeted Vitest route/service suites |
| Auth/access control | Admin/finance/lodge | Role boundaries for admin, finance viewer/manager, lodge kiosk | High | API route tests and page guard tests | Targeted guard tests; manual role checks on staging |
| Booking/capacity | Member | Create booking with capacity lock and per-guest stay ranges | Critical | Service tests, concurrency tests, manual booking flow | Targeted booking/capacity suites |
| Booking/capacity | Member/admin | Waitlist, offer expiry, force-confirm, bump/cancel | High | Service tests and cron tests | Targeted waitlist tests plus safe cron unit tests |
| Payment/refund/credit | Member/admin | Stripe payment success/failure, saved card, refund, member credit | Critical | Unit/service tests with Stripe mocked | Targeted payment, refund, credit suites |
| Payment/refund/credit | Member/admin | Internet Banking/Xero invoice settlement distinct from Stripe | Critical | Service tests with Xero mocked | Targeted Xero booking invoice/reconciliation tests |
| Webhook replay/idempotency | Stripe/Xero/SES | Valid, duplicate, malformed, oversized, and wrong-signature payloads | Critical | Route tests with fake signed payloads | Targeted webhook route tests, no live provider calls |
| Cron rerun/recovery | Scheduler | Payment recovery, pending confirmation, waitlist, Xero retry, email retry | High | Unit/route tests with local DB or mocks | Targeted cron tests; never use production `CRON_SECRET` |
| Membership lifecycle | Applicant/member/admin | Application, nomination reminders, admin refresh/replacement, approval, cancellation, archive, delete | High | Service tests, cron tests, and admin route tests | Targeted membership/lifecycle suites |
| Membership lifecycle | Admin | Configure seasonal membership types, archive/reactivate/reorder policy records, and preserve role-based authorization | High | Schema, migration/backfill, admin route, and navigation tests | Targeted membership type seed/API/sidebar suites; no booking enforcement claims |
| Family/dependents | Member/admin | Adult invitations, dependents, inherited email, age-up | High | Service tests and UI route tests | Targeted family/dependent tests |
| Xero/SES failure | Admin/operator | Xero outbox failure/retry, SES suppression/failure visibility | High | Service tests with provider mocks | Targeted Xero outbox/email retry tests |
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
