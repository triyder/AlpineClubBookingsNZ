# Changelog

All notable public reference-release changes should be recorded here.

## 0.7.0 - 2026-06-08

- Added room and bed allocation management with admin room/bed inventory,
  first-fit family-aware allocation planning, automatic lifecycle
  reconciliation for booking confirmation/edit/cancel/waitlist flows, manual
  allocation controls, approval tracking, and focused bed-allocation filters.
- Added per-guest booking date ranges to the live booking and modification
  flows, including capacity accounting, quote validation, waitlist, roster, and
  finance/reporting paths that count only each guest's actual stay nights.
- Added fixed-nightly-price promo codes with set-price and cap-only modes,
  integer-cent promo adjustment tracking, member/profile display, booking edit
  support, Xero invoice handling, and promo-admin validation.
- Added Internet Banking payment support backed by operational Xero invoices,
  first-class `PaymentSource` typing, payment option discovery, booking-detail
  invoice/reference display, and inbound Xero reconciliation for settlement
  instead of routing bank-transfer bookings through Stripe.
- Added booking reduction settlement choices so negative booking modifications
  can become either Stripe refund work or idempotent member account credits,
  with source-linked modification credits and Xero settlement payload coverage.
- Added the member CSV import wizard with column mapping, date-format handling,
  preview/failure reporting, skip counts, and hardened import validation.
- Added admin operational filters and drilldowns for booking payment source,
  Xero sync state, bed allocation state, per-guest ranges, change/refund state,
  payment settlement kind, Xero operations, and inbound Xero events.
- Hardened payment and accounting boundaries so Internet Banking bookings do
  not enter Stripe-only PaymentIntent, refund, or recovery paths and Xero
  invoice settlement is driven by the inbound reconciliation path.
- Hardened API and operational surfaces with centralized malformed-JSON
  responses on changed routes, cron/payment/Xero audit visibility, and a pinned
  Turbopack root for predictable Next.js 16 builds.
- Migration/deployment notes:
  - New optional module gates are `FEATURE_BED_ALLOCATION` and
    `FEATURE_INTERNET_BANKING_PAYMENTS`; Internet Banking also requires
    operational Xero capability, credentials, and tenant connection.
  - `20260607120000_add_bed_allocation_and_internet_banking_modules` adds the
    Admin Modules activation booleans for bed allocation and Internet Banking.
  - `20260607130000_add_fixed_nightly_promo_adjustments` adds fixed-nightly
    promo types and integer-cent adjustment columns on booking/promo redemption
    records; deploy during low promo-booking traffic.
  - `20260607133000_add_bed_allocation_inventory` and
    `20260607142000_add_bed_allocation_settings` add the room, bed, allocation,
    and settings tables used by admin bed allocation.
  - `20260607150000_add_payment_source_foundation` adds first-class Stripe vs
    Internet Banking payment source fields; do not enable Internet Banking
    payments for members until old app colors have drained.
  - `20260607164000_add_booking_modification_credit_source` and
    `20260607165000_make_booking_modification_credit_unique` add source-linked,
    idempotent member credits for booking reductions.

## 0.6.0 - 2026-06-03

- Added booking review and approval workflows, including `AWAITING_REVIEW`
  booking status handling, member justification capture, admin review APIs,
  approval queue views, and route coverage for review, modify, cancel,
  force-confirm, and report paths.
- Added child family request dependant creation, no-adult booking review
  handling, unpaid cancelled booking deletion, and clearer admin queue
  navigation for booking and family-group review work.
- Added promo-code finance improvements with per-promo-code Xero coding,
  split per-booking and lifetime free-night caps, partial discount support,
  and migration coverage for promo and review data changes.
- Hardened privileged, public, webhook, payment, Xero, runtime-status, cron,
  route-guard, and external-service boundaries with focused tests and security
  documentation.
- Updated CI and deployment hardening, including gitleaks v3, dependency review,
  static analysis, Docker image scanning, migration-safety documentation, and
  production image runtime dependency packaging.
- Refreshed minor and patch dependencies across the application stack, including
  Next.js, React, Sentry, Stripe, Nodemailer, Vitest, ESLint, and related lockfile
  entries, while retaining explicit security overrides for vulnerable transitive
  packages.

## 0.5.0 - 2026-05-28

- Added safe booking deletion with nullable booking soft-delete fields, admin
  visibility filtering, deletion audit coverage, and a migration safety ledger
  entry for the hot `Booking` table.
- Added the archive lifecycle review queue and admin/member lifecycle surfaces
  for governed archive handling.
- Fixed promo beneficiary cap accounting with per-member promo redemption
  allocations, allocation-aware redemption counts, and migration coverage for
  existing redemptions.
- Fixed placeholder subscription delete blockers so draft and placeholder guest
  subscriptions no longer block legitimate member cleanup paths.
- Folded the blue/green deploy engine into
  `scripts/run-production-blue-green-deploy.sh` and removed the old
  `scripts/blue-green-deploy.sh` entrypoint.
- Extracted focused helpers and tests for family admin UI behavior, booking
  guest removal, membership cancellation blockers, admin audit queries, finance
  booking metrics, and Xero outbox payload parsing.
- Migration/deployment notes:
  - `20260527090000_add_booking_soft_delete_fields` adds nullable
    `Booking.deletedAt`, `Booking.deletedById`, and `Booking.deletedReason`
    columns, supporting indexes, and a `SET NULL` member foreign key. The
    ledger marks it as an expand migration that old code ignores; deploy during
    low booking traffic and let the deploy guard stop on lock timeout or
    migration failure before cutover.
  - `20260527120000_add_promo_redemption_allocations` creates
    `PromoRedemptionAllocation`, backfills one allocation per existing
    `PromoRedemption`, recalculates `PromoCode.currentRedemptions`, and installs
    insert/update triggers so old app colors continue writing one-booker
    allocations during blue/green drain. Run it during low promo-booking
    traffic.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` records both new migrations as
    expand-phase and old-code-compatible. They do not require a breaking
    migration override.
  - The production wrapper now resolves the deploy ref, derives SHA-tagged GHCR
    image references unless both `APP_IMAGE` and `MIGRATE_IMAGE` are supplied,
    creates a clean archive workspace, preserves the live Caddy upstream state,
    runs the integrated internal blue/green flow, syncs the source checkout to
    the deployed commit, and prunes stale deploy workspaces.

## 0.4.0 - 2026-05-26

- Added adopter-focused implementation and documentation index guides.
- Made public GHCR image publishing easier to reuse from forks.
- Removed completed repository-split planning artifacts from the public tree.
- Replaced remaining public-facing legacy TACBookings wording with generic
  booking-system language.
- Added admin-initiated membership cancellation requests and cancellation
  refund-policy copy in member/admin email paths.
- Expanded booking-change request handling with review-queue alignment, linked
  executed modifications, notification preferences, and refund-recovery
  coverage.
- Hardened payment, Xero, and external-service operations with Stripe webhook
  observability, stale recovery alerts, token redaction, and safer error
  handling.
- Continued maintainability work across booking creation/modification services,
  route boundaries, admin member pages, admin Xero panels, Xero integration
  modules, and the quality-report baseline.
- Added migration safety coverage for post-0.3.0 changes, including
  BookingGuest stay-range constraints and the promo-code per-individual
  redesign.

## 0.3.0 - 2026-05-24

- Added admin-managed email message configuration, previews, resets, delivery
  policies, and email message audit documentation.
- Added durable Stripe payment recovery and cleanup for superseded zero-dollar
  booking intents.
- Expanded booking editing with guest stay ranges, future-night edits,
  member/admin change requests, and Xero booking-edit settlement handling.
- Added membership cancellation workflows for member requests, confirmations,
  admin approval, participant handling, configurable settings, and Xero
  cancellation handling.
- Added governed member lifecycle flows for safe delete and archive requests.
- Improved admin and operational surfaces, including setup readiness, cron and
  payment maintenance, kiosk/lodge date scoping, finance metrics, and dark mode.

## 0.2.0 - 2026-05-21

- Added the setup wizard and Admin Modules settings/effective-state workflow.
- Tightened public onboarding, security headers, and issue-report origin
  handling.
- Ported generic public-site and module-migration fixes back to the shared
  reference application.
- Extracted booking policy and member credit ledger rules for clearer
  maintenance.
- Fixed cron health reporting for expected job history.
- Fixed zero-dollar booking batch edits so payment-pending bookings that become
  free are settled as paid.

## 0.1.0 - 2026-05-17

- Prepared the repository for a public MIT reference release.
- Added public governance, support, security, and contribution documents.
- Removed private audit queues, agent handoffs, and internal review artifacts
  from the public tree.
- Added public GitHub issue and pull request templates.
- Renamed public GHCR image packages to `alpineclubbookingsnz-app` and
  `alpineclubbookingsnz-migrate`.
- Published the initial AlpineClubBookingsNZ production application baseline.
