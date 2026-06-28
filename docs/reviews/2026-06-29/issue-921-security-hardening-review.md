# Issue #921 Security Hardening Review

Date: 2026-06-29
Review branch: `codex/issue-921-security-hardening-review`
Review baseline: `origin/main` at `bb5890af` after #915 through #920 merged
Mode: review with focused in-scope hardening fixes

## Recommendation

Three in-scope hardening findings were identified and fixed in this PR. No
remaining release-blocking finding was found in the reviewed Addy, membership
type, or committee-profile scope, subject to PR CI passing.

## Scope And Safety

- Dependencies #915, #916, #917, #918, #919, and #920 were verified merged
  before this review started.
- The review inspected current public `origin/main`, the issue bodies for
  #915 through #920, the merged PR file sets, and the touched routes, schemas,
  migrations, docs, and tests.
- No production credentials, production databases, production backups, live
  Stripe, live Xero, live SES, live Sentry, live Addy, provider webhooks, live
  endpoint scans, browser automation, or dev servers were used.
- Installed Next.js docs under `node_modules/next/dist/docs/` could not be read
  because this fresh worktree has no `node_modules`; no dependency install was
  run under the owner's CI-only validation instruction.

## Findings

| ID | Severity | Scope | Status |
| --- | --- | --- | --- |
| F-01 | High | Committee contact privacy | Fixed in this PR |
| F-02 | Medium | Seasonal assignment guarded save | Fixed in this PR |
| F-03 | Medium | Membership type booking policy responses | Fixed in this PR |

### F-01: Committee Routed Contact Email Was Persisted In EmailLog

Severity: High
Affected files: `src/app/api/contact/route.ts`, `src/lib/email.ts`
Validation status: Fixed with targeted unit coverage; PR CI is the execution
gate.

Evidence:

- `/api/committee` already avoided selecting member email and only returned
  active, published assignment records with active roles and active members in
  `src/app/api/committee/route.ts:15` through
  `src/app/api/committee/route.ts:24`.
- `/api/contact` correctly resolved contactable assignment keys server-side in
  `src/app/api/contact/route.ts:27` through
  `src/app/api/contact/route.ts:40`.
- The generic email helper persisted the concrete `to` recipient in EmailLog
  for every send. For committee contact routing, that meant a private member
  email could still appear in operational email logs.

Fix:

- `sendEmail()` now accepts `logRecipient` and writes that value to EmailLog,
  app logs, and suppression logs while still sending SMTP to the actual `to`
  address in `src/lib/email.ts:206` through `src/lib/email.ts:359`.
- Redacted-recipient sends force `htmlBody: null` so automatic email retry does
  not lose the real recipient and accidentally retry to an opaque marker in
  `src/lib/email.ts:237` through `src/lib/email.ts:257`.
- `/api/contact` now passes `committee-contact:<assignment id>` for valid
  committee-routed messages and keeps fallback club-contact logging unchanged in
  `src/app/api/contact/route.ts:72` through
  `src/app/api/contact/route.ts:118`.
- Coverage was added in `src/lib/__tests__/phase6a-notifications.test.ts` and
  `src/lib/__tests__/email-header-injection.test.ts`.

### F-02: Seasonal Preview Tokens Used A Local Fallback Secret In Production

Severity: Medium
Affected files: `src/lib/seasonal-membership-assignments.ts`
Validation status: Fixed with targeted unit coverage; PR CI is the execution
gate.

Evidence:

- Seasonal membership saves are admin-only and verify a preview token before
  writing, but the token secret had a local fallback even if `AUTH_SECRET` and
  `NEXTAUTH_SECRET` were missing.
- Setup readiness already blocks missing auth secrets, but the token builder
  should still fail closed in a misconfigured production runtime.

Fix:

- Production preview-token creation now requires `AUTH_SECRET` or
  `NEXTAUTH_SECRET` and throws if neither exists in
  `src/lib/seasonal-membership-assignments.ts:251` through
  `src/lib/seasonal-membership-assignments.ts:261`.
- Local/test behavior keeps the deterministic local fallback for non-production
  development.
- Coverage was added in
  `src/lib/__tests__/seasonal-membership-assignments.test.ts`.

### F-03: Booking Edit Pricing Catches Could Mask Membership Policy Errors

Severity: Medium
Affected files: `src/lib/booking-modify.ts`,
`src/lib/booking-date-modification-service.ts`,
`src/app/api/bookings/[id]/guests/route.ts`
Validation status: Fixed with targeted invariant coverage; PR CI is the
execution gate.

Evidence:

- The shared membership type policy is type-driven and season-aware:
  assignments override role defaults in `src/lib/membership-type-policy.ts:201`
  through `src/lib/membership-type-policy.ts:296`, `BLOCK_BOOKING` throws a
  structured 403 in `src/lib/membership-type-policy.ts:333` through
  `src/lib/membership-type-policy.ts:397`, `NON_MEMBER_RATE` is applied before
  pricing in `src/lib/membership-type-policy.ts:400` through
  `src/lib/membership-type-policy.ts:474`, and `NOT_REQUIRED` is layered over
  raw subscription history in `src/lib/membership-type-policy.ts:476` through
  `src/lib/membership-type-policy.ts:510`.
- Some booking edit pricing paths had generic pricing catches that converted
  any pricing exception to a season-rate `400`. Today those paths generally run
  `assertMembershipTypeBookingAllowed()` first, but the generic catch was a
  brittle boundary for future edits.

Fix:

- Booking edit pricing catches now rethrow `MembershipTypeBookingPolicyError`
  before returning generic season-rate errors in `src/lib/booking-modify.ts`,
  `src/lib/booking-date-modification-service.ts`, and
  `src/app/api/bookings/[id]/guests/route.ts`.
- Static invariant coverage was added in
  `src/lib/__tests__/membership-type-policy.test.ts`.

## Area Review Notes

### Addy Address Autocomplete

Result: No remaining finding.

- The Addy module defaults off in `src/config/modules.ts` and maps to
  `/api/address-autocomplete` in `src/config/feature-routes.ts:71` through
  `src/config/feature-routes.ts:74`.
- The proxy returns safe 404 responses for disabled module routes before route
  handlers run in `src/proxy.ts:17` through `src/proxy.ts:38`, and its matcher
  includes `/api/address-autocomplete/:path*` at `src/proxy.ts:111`.
- Addy route handlers rate limit and validate inputs before the Addy wrapper is
  called in `src/app/api/address-autocomplete/search/route.ts:8` through
  `src/app/api/address-autocomplete/search/route.ts:23`.
- Addy credentials are read only from server environment variables inside
  `src/lib/addy-api.ts`; admin responses expose readiness state, not secrets.

### Membership Types And Booking Enforcement

Result: F-02 and F-03 fixed; no remaining finding.

- Access role, seasonal membership type, and committee assignment remain
  separate axes; no `COMMITTEE` role was added to `Member.role`.
- `BLOCK_BOOKING`, `NON_MEMBER_RATE`, and `NOT_REQUIRED` are enum behavior
  fields on membership types and are not inferred from display names.
- Booking create, quote, draft confirmation, guest add/remove, date/guest
  modification, group join, admin booking-request approval, promo validation,
  and subscription-display paths route through the shared membership type
  policy helpers reviewed above.
- Existing bookings are not silently repriced by seasonal assignment changes;
  the admin preview reports affected future confirmed, draft, and waitlist
  rows before an audited save.
- Raw `MemberSubscription` and Xero invoice history remains stored and visible;
  `NOT_REQUIRED` is only the effective subscription status layer.

### Committee Public Privacy

Result: F-01 fixed; no remaining finding.

- Public committee data comes from active, published `CommitteeAssignment`
  records with active roles and active members, capped at 50 rows.
- Public serialization excludes email, returns phone only when `showPhone` is
  true, and returns an assignment contact key only when `contactable` is true.
- `/api/contact` validates and rate limits anonymous submissions, resolves only
  active/published/contactable assignment ids, strips CRLF from recipient labels,
  and falls back to the configured club contact address for invalid or
  non-contactable recipient keys.
- Committee-routed contact messages no longer persist the private member
  recipient in EmailLog rows.

### Admin Routes, Audits, And Migrations

Result: No remaining finding.

- Membership type and committee role/assignment admin routes require
  `requireAdmin()`, use strict Zod schemas, validate route params, and write
  structured audit logs for sensitive changes.
- Seasonal member assignment changes require admin auth, preview-token
  verification, an admin reason, and a critical structured audit event.
- Migrations added by #915, #916, and #919 are documented in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` as expand-compatible. They add
  defaulted/nullable columns or new tables/enums and do not destructively
  change existing booking, payment, member, subscription, or committee legacy
  rows.

## Validation

Local validation intentionally followed the owner's current instruction to skip
local lint, Prisma validation/generate, typecheck, tests, and build and let PR
CI run those checks.

Local command run:

- `git diff --check` (pass)

Not run locally by instruction:

- `npm run lint`
- `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate`
- `DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma generate`
- `npx tsc --noEmit`
- targeted Vitest suites
- `npm test`
- `npm run build`

## Residual Risks

- No local browser/network manual checks were run; committee and Addy response
  inspection should be covered by PR CI and later owner deployment checks.
- No live providers or production data were used, so live Addy/SES behavior was
  not exercised.
- Email transport providers can still record actual recipients outside the app;
  this review fixed application EmailLog/app logger exposure.
