# Issue #922 Feature Harmony Cross-Check

Date: 2026-06-29
Review branch: `codex/issue-922-feature-harmony-review`
Review baseline: `origin/main` at `581a9001` after #915 through #921 merged
Mode: review with focused in-scope docs/UX copy fixes

## Recommendation

One small operator-facing wording mismatch was found and fixed in this PR. No
remaining release-blocking harmony issue was found across the Addy module,
seasonal membership type, booking/subscription enforcement, committee profile,
public contact, setup, navigation, or documentation surfaces reviewed, subject
to PR CI passing.

## Scope And Safety

- Dependencies #915 through #921 were verified merged before this review.
- The review inspected the issue bodies and merged PR file sets for #915
  through #921, plus the current implementation and docs named by #922.
- No production credentials, production databases, production backups, live
  Stripe, live Xero, live SES, live Sentry, live Addy, provider webhooks, live
  endpoint scans, browser automation, dev servers, or production data were used.
- Installed Next.js docs under `node_modules/next/dist/docs/` could not be read
  because this fresh worktree has no `node_modules`; no dependency install was
  run under the owner's CI-only validation instruction.

## Dependency Evidence

| Issue | PR | Merge commit | Status |
| --- | --- | --- | --- |
| #915 Addy address autocomplete module gating | #926 | `cacbe17b` | Merged |
| #916 Seasonal membership type foundation | #931 | `6f74f4b` | Merged |
| #917 Member seasonal assignment UI | #936 | `44d82be` | Merged |
| #918 Membership type booking/subscription enforcement | #939 | `4acbfad` | Merged |
| #919 Committee master roles and assignments | #940 | `4cd3b3a` | Merged |
| #920 Public committee contact privacy | #941 | `bb5890a` | Merged |
| #921 Security hardening review | #942 | `581a900` | Merged |

## Findings

| ID | Severity | Scope | Status |
| --- | --- | --- | --- |
| F-01 | Low | Admin page-content token help and email audit wording | Fixed in this PR |

### F-01: Contact Token Help Still Implied Committee-Only Routing

Severity: Low
Affected files: `src/components/admin/page-content-panel.tsx`,
`docs/email-message-audit.md`
Validation status: Fixed with copy/docs changes; PR CI is the execution gate.

Evidence:

- The current contact form has a general contact option and adds committee
  recipient options only from `/api/committee` members with a `contactKey`.
- `/api/contact` falls back to the configured club contact address unless the
  recipient resolves to an active, published, contactable committee assignment.
- The page-content token help still said `{{contact-form}}` lets a user send a
  message "to the committee", and the email audit described routing to an
  "active committee member" rather than the assignment-gated privacy model.

Fix:

- Updated the page-content token help to say the contact form sends to the club
  or to a published contactable committee assignment.
- Updated the email message audit to describe published, active, contactable
  assignment routing and opaque recipient markers for committee-routed app logs.

## Scenario Matrix

| Scenario | Result |
| --- | --- |
| Addy off, credentials absent | Coherent. `addressAutocomplete` defaults off, `/api/address-autocomplete/**` is proxy-gated, setup shows disabled/manual-entry copy, and address fields remain editable. |
| Addy on, credentials present or Addy fails | Coherent. Setup/modules distinguish ready versus missing credentials; routes keep credentials server-side; client failures show manual-entry fallback. |
| Admin plus committee | Coherent. Committee assignments are separate records; member access role remains `ADMIN` and is displayed separately from seasonal type and committee controls. |
| Lodge plus committee | Coherent. `LODGE` remains an access role only; public committee output requires an explicit active, published assignment. |
| Ordinary member plus committee | Coherent. Assignment routes do not mutate access role or seasonal membership type and public/contact metadata does not grant app access. |
| Life or other `NOT_REQUIRED` type | Coherent. Effective subscription status becomes `NOT_REQUIRED` while raw subscription/Xero history remains selected and displayed separately. |
| Associate/Reserve-style `NON_MEMBER_RATE` | Coherent. Pricing policy forces non-member nightly rates while restoring member identity in returned price breakdowns. |
| `BLOCK_BOOKING` type | Coherent. Shared policy throws structured `MEMBERSHIP_TYPE_BLOCKS_BOOKING` errors for booking owners and member guests across quote, create, modify, guest-add, draft confirmation, group join, and booking-request approval paths. |
| Xero off | Coherent. Subscription enforcement is inactive when Xero integration is off; membership-type booking blocks still apply independently. |
| Subscription lockout on/off | Coherent. Precedence is documented in code: `NOT_REQUIRED` membership type and operational roles bypass first; Xero-off or lockout-off makes booking subscription enforcement inactive. |
| Public committee/contact | Coherent. Public API selects no email, phone is `showPhone` gated, contact keys are `contactable` gated, and `/api/contact` resolves assignment ids server-side with safe fallback. |

## Area Review Notes

### Admin Navigation And Settings

- Admin sidebar includes Modules, Membership Types, Committee, Setup, and
  Subscription Lockout in the expected settings/configuration areas.
- Feature-aware sidebar filtering uses the same `feature-routes` map as the
  proxy; membership-type and committee settings are not incorrectly module
  gated.
- The page-content token help now matches the public contact routing model.

### Setup And Modules

- `addressAutocomplete` is present in `MODULE_KEYS`,
  `DEFAULT_MODULE_SETTINGS`, Admin Modules API/UI payloads, setup readiness,
  `src/config/feature-routes.ts`, and `src/proxy.ts`.
- Setup readiness distinguishes disabled, enabled with missing Addy
  credentials, and enabled with credentials configured without exposing secret
  values.
- Admin Modules remain the single effective module-state source; provider
  credentials are setup dependencies, not module settings.

### Seasonal Membership And Member Editing

- Access role, seasonal membership type, and committee assignments are rendered
  as separate member detail cards/controls.
- Seasonal membership changes require preview, admin reason, preview-token
  verification, and a structured audit event.
- The preview includes future confirmed bookings, drafts, waitlist records,
  current subscription state, and subscription history; it warns that existing
  future bookings are not automatically repriced.

### Booking And Subscription Enforcement

- The shared membership-type policy resolver is season-aware and type-driven.
  It uses explicit seasonal assignments first, then role defaults or built-in
  fallback policy records.
- Booking quote/create, draft confirmation, date/guest modification, guest-add,
  group-member join, booking-request approval, promo validation, and booking
  services call the shared policy helpers for block/rate enforcement.
- `NON_MEMBER_RATE` changes pricing inputs only for rate selection and restores
  the original member identity in returned price breakdowns.
- `NOT_REQUIRED` is an effective subscription layer and does not delete or hide
  raw `MemberSubscription`/Xero fields.

### Public Committee, Contact, And Page Tokens

- `/api/committee` returns only active, published committee assignments linked
  to active roles and members, capped at 50 rows.
- Public serialization excludes member email, returns phone only when
  `showPhone` is enabled, and returns `contactKey` only when contactable.
- `/api/contact` validates and rate-limits anonymous submissions, resolves only
  active/published/contactable assignment ids, redacts committee-routed
  application email logs, and falls back to the club contact address.
- The starter `/committee` page uses `{{committee-members-cards}}`; `/contact`
  uses `{{contact-form}}`; website navigation/footer links resolve to existing
  static or editable public pages.

## Validation

Local validation intentionally follows the owner's current instruction to skip
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

## Follow-Up Issues

None created. No larger out-of-scope finding was identified during this
cross-check.

## Residual Risks

- No local browser/network manual checks were run; public committee/contact and
  Addy payload inspection remains covered by automated PR CI and later owner
  deployment checks.
- No live providers or production data were used, so live Addy/SES/Xero behavior
  was not exercised.
- This review was static/source-based under the owner's CI-only instruction;
  PR CI remains the gate for lint, typecheck, tests, build, migration drift,
  dependency review, secret scanning, static analysis, CodeQL, and container
  security checks.
