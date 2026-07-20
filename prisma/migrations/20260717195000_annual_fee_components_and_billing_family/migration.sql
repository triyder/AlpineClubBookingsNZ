-- Annual membership fee components (multi-line Xero invoices) + per-member
-- billing family (#1932, E6, epic #1926 items 9 + 6).
--
-- Part 1: MembershipAnnualFee gains named components (base membership + work
-- party fee + FMC subscription, ...), each an own Xero invoice line with an
-- optional own GL account/item mapping and per-component proration flag. The fee
-- total stays authoritative (Σ components == fee.amountCents, validated in code),
-- so existing preview/consumers are unchanged. Immutable subscription charges get
-- a frozen per-line component snapshot; the immutable-charge invariant extends to
-- these rows.
--
-- Backfill (owner-approved additive derivation, 2026-07-16 — restated on the PR):
--   * one default component per existing non-NO_INVOICE MembershipAnnualFee
--     (label "Annual membership fee", amount = fee.amountCents, prorate true,
--     no per-component account/item override);
--   * one snapshot component per existing invoiceable MembershipSubscriptionCharge
--     derived VERBATIM from its own frozen columns, with the description built
--     from the EXACT historical invoice-build template including pluralization
--     ("<typeName> membership <Y>/<Y+1> (<N> month[s])", coveredMonths = 1 →
--     "(1 month)"), so a legacy charge re-driven through the outbox reproduces
--     the identical single line. Only additive frozen values are derived — no
--     existing charge, invoice, or amount is mutated. NO_INVOICE charges (zero
--     total, no components) and the vanishingly rare null-account charge (already
--     un-invoiceable; the builder's account-code guard fires before any component
--     line is read) get no component row.
--
-- Part 2: Member.billingFamilyGroupId resolves multi-family PER_FAMILY billing
-- ambiguity. onDelete SET NULL; the six FamilyGroupMember removal paths also NULL
-- it in-transaction so a stale pointer degrades to a visible
-- INVALID_BILLING_FAMILY_SELECTION at the next billing preview, never silent
-- misbilling.
--
-- Money stays integer cents; dates stay date-only.

-- ---------------------------------------------------------------------------
-- 1. MembershipAnnualFeeComponent table
-- ---------------------------------------------------------------------------
CREATE TABLE "MembershipAnnualFeeComponent" (
  "id" TEXT NOT NULL,
  "membershipAnnualFeeId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "prorate" BOOLEAN NOT NULL DEFAULT true,
  "xeroAccountCode" TEXT,
  "xeroItemCode" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MembershipAnnualFeeComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MembershipAnnualFeeComponent_membershipAnnualFeeId_sortOrde_idx"
  ON "MembershipAnnualFeeComponent" ("membershipAnnualFeeId", "sortOrder");

ALTER TABLE "MembershipAnnualFeeComponent"
  ADD CONSTRAINT "MembershipAnnualFeeComponent_membershipAnnualFeeId_fkey"
  FOREIGN KEY ("membershipAnnualFeeId") REFERENCES "MembershipAnnualFee" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. MembershipSubscriptionChargeComponent table (immutable snapshot)
-- ---------------------------------------------------------------------------
CREATE TABLE "MembershipSubscriptionChargeComponent" (
  "id" TEXT NOT NULL,
  "chargeId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "annualAmountCents" INTEGER NOT NULL,
  "chargedAmountCents" INTEGER NOT NULL,
  "prorated" BOOLEAN NOT NULL,
  "xeroAccountCode" TEXT NOT NULL,
  "xeroItemCode" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MembershipSubscriptionChargeComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MembershipSubscriptionChargeComponent_chargeId_sortOrder_idx"
  ON "MembershipSubscriptionChargeComponent" ("chargeId", "sortOrder");

ALTER TABLE "MembershipSubscriptionChargeComponent"
  ADD CONSTRAINT "MembershipSubscriptionChargeComponent_chargeId_fkey"
  FOREIGN KEY ("chargeId") REFERENCES "MembershipSubscriptionCharge" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Member.billingFamilyGroupId (per-member billing family)
-- ---------------------------------------------------------------------------
ALTER TABLE "Member" ADD COLUMN "billingFamilyGroupId" TEXT;

CREATE INDEX "Member_billingFamilyGroupId_idx" ON "Member" ("billingFamilyGroupId");

ALTER TABLE "Member"
  ADD CONSTRAINT "Member_billingFamilyGroupId_fkey"
  FOREIGN KEY ("billingFamilyGroupId") REFERENCES "FamilyGroup" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Backfill default components for existing annual fees (non-NO_INVOICE)
-- ---------------------------------------------------------------------------
INSERT INTO "MembershipAnnualFeeComponent"
  ("id", "membershipAnnualFeeId", "label", "amountCents", "prorate", "xeroAccountCode", "xeroItemCode", "sortOrder", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  f."id",
  'Annual membership fee',
  f."amountCents",
  true,
  NULL,
  NULL,
  0,
  timezone('UTC', statement_timestamp()),
  timezone('UTC', statement_timestamp())
FROM "MembershipAnnualFee" f
WHERE f."billingBasis" <> 'NO_INVOICE';

-- ---------------------------------------------------------------------------
-- 5. Backfill snapshot components for existing invoiceable charges
--    (additive; verbatim from frozen columns; exact historical description)
-- ---------------------------------------------------------------------------
INSERT INTO "MembershipSubscriptionChargeComponent"
  ("id", "chargeId", "label", "description", "annualAmountCents", "chargedAmountCents", "prorated", "xeroAccountCode", "xeroItemCode", "sortOrder", "createdAt")
SELECT
  gen_random_uuid()::text,
  c."id",
  'Annual membership fee',
  c."membershipTypeName" || ' membership ' || c."seasonYear"::text || '/' || (c."seasonYear" + 1)::text
    || ' (' || c."coveredMonths"::text || ' month' || CASE WHEN c."coveredMonths" = 1 THEN '' ELSE 's' END || ')',
  c."annualAmountCents",
  c."chargedAmountCents",
  true,
  c."xeroAccountCode",
  c."xeroItemCode",
  0,
  timezone('UTC', statement_timestamp())
FROM "MembershipSubscriptionCharge" c
WHERE c."billingBasis" <> 'NO_INVOICE'
  AND c."xeroAccountCode" IS NOT NULL;
