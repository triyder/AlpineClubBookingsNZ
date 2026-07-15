-- Additive family-billing-mode setting (#159). Old application versions ignore
-- the new enum and column entirely, and the constant default preserves today's
-- family-billing behaviour for every existing deployment.
CREATE TYPE "FamilyBillingMode" AS ENUM ('BILL_FAMILY_VIA_BILLING_MEMBER', 'BILL_MEMBERS_INDIVIDUALLY');

-- Single-row (id='default') settings table; the ADD COLUMN with a constant
-- default is a catalog-only change on PostgreSQL 11+ (no table rewrite, brief
-- lock). The default keeps existing clubs on the pre-#159 family-billing model.
ALTER TABLE "MembershipSubscriptionBillingSettings"
  ADD COLUMN "familyBillingMode" "FamilyBillingMode" NOT NULL DEFAULT 'BILL_FAMILY_VIA_BILLING_MEMBER';
