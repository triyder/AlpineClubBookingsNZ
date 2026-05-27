# Changelog

All notable public reference-release changes should be recorded here.

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
