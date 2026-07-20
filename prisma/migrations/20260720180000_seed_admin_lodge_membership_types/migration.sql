-- Issue #2149: seed the built-in ADMIN and LODGE membership types.
--
-- The role-based subscription exemption (roleNeverRequiresSubscription) is
-- dropped: membership type — subscriptionBehavior, plus age tier where the type
-- is BASED_ON_AGE_TIER — is now the SOLE authority for whether a member owes a
-- subscription. Role becomes a pure permission concept.
--
-- With the exemption gone, resolveMembershipTypePoliciesForMembers falls back
-- (for a member with no SeasonalMembershipAssignment) to
-- defaultMembershipTypeKeyForRole. That fallback now maps ADMIN -> the ADMIN
-- type and LODGE -> the LODGE type (previously both fell through to FULL, which
-- is billable). Those two built-in types therefore MUST exist in the database:
--   * the annual billing preview resolves fallback types FROM THE DATABASE
--     (membership-subscription-billing.ts) and raises MISSING_MEMBERSHIP_ASSIGNMENT
--     for a fallback key with no DB row, and
--   * a bare LODGE kiosk account hits the booking gate at season rollover without
--     the ADMIN session bypass, so its fallback type must be NOT_REQUIRED (never
--     owe a subscription) while KEEPING member booking-rate access.
--
-- New built-in types:
--   ADMIN — subscriptionBehavior NOT_REQUIRED, bookingBehavior BLOCK_BOOKING
--           (a bare admin account is operational and does not book as itself; a
--            real fee-paying human holding the admin permission is assigned a
--            real membership type and is unaffected by this fallback).
--   LODGE — subscriptionBehavior NOT_REQUIRED, bookingBehavior MEMBER_RATE
--           (kiosk must still book on behalf of members).
--
-- Idempotent AND self-healing: ensureBuiltInMembershipTypes upserts with
-- update:{}, so it will NOT correct a pre-existing hand-created "ADMIN"/"LODGE"
-- key row that carries the wrong behaviour. This migration create-if-missing AND
-- reconciles the behaviour columns + isBuiltIn/isActive of any such local row,
-- while preserving an admin-edited name/description.
--
-- Blue/green: DATA-ONLY (no DDL, no schema change) on the cold, admin-only
-- MembershipType and MembershipTypeAgeTier config tables — neither is in
-- HOT_TABLE_SQL_REGEX and there is no destructive SQL. All INSERT/UPDATE payload
-- timestamps use explicit UTC via timezone('UTC', statement_timestamp()) — no
-- session-clock CURRENT_TIMESTAMP/now() DML (the #1656/#1627 gate); the only
-- CURRENT_TIMESTAMP in either table is a DDL column DEFAULT set by an earlier
-- migration. Old-colour compatible: the previously deployed runtime still resolves
-- ADMIN/LODGE via the OLD role-based exemption and never reads these two new type
-- rows for a subscription decision, so seeding them changes no old-colour output;
-- the new colour reads them via the role->default-type fallback after cutover.
-- Safe at any traffic level.

-- 1. Built-in ADMIN and LODGE membership types (create-if-missing, reconcile behaviour).
INSERT INTO "MembershipType" (
  "id",
  "key",
  "name",
  "description",
  "isActive",
  "isBuiltIn",
  "bookingBehavior",
  "subscriptionBehavior",
  "sortOrder",
  "updatedAt"
) VALUES
  (
    'builtin-membership-type-admin',
    'ADMIN',
    'Admin',
    'Operational administrator account. Carries no Annual Membership Fee obligation and does not book the lodge as itself.',
    true,
    true,
    'BLOCK_BOOKING',
    'NOT_REQUIRED',
    6,
    timezone('UTC', statement_timestamp())
  ),
  (
    'builtin-membership-type-lodge',
    'LODGE',
    'Lodge',
    'Shared lodge kiosk account. Carries no Annual Membership Fee obligation but keeps member booking-rate access for kiosk bookings.',
    true,
    true,
    'MEMBER_RATE',
    'NOT_REQUIRED',
    7,
    timezone('UTC', statement_timestamp())
  )
ON CONFLICT ("key") DO UPDATE
SET
  "isBuiltIn" = true,
  "isActive" = true,
  "bookingBehavior" = EXCLUDED."bookingBehavior",
  "subscriptionBehavior" = EXCLUDED."subscriptionBehavior";

-- 2. Allowed age tier for each new type (single real person tier; keeps them off
--    the opt-in N/A path). Deterministic ids + ON CONFLICT keep re-runs no-ops.
INSERT INTO "MembershipTypeAgeTier" (
  "id",
  "membershipTypeId",
  "ageTier",
  "updatedAt"
)
SELECT
  'builtin-mtat-' || lower(mt."key") || '-adult',
  mt."id",
  'ADULT'::"AgeTier",
  timezone('UTC', statement_timestamp())
FROM "MembershipType" mt
WHERE mt."key" IN ('ADMIN', 'LODGE')
ON CONFLICT ("membershipTypeId", "ageTier") DO NOTHING;
