-- Authoritative, effective-dated membership and entrance fees. Existing Xero
-- amount columns intentionally remain for one compatibility release.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "MembershipFeeBillingBasis" AS ENUM ('PER_MEMBER', 'PER_FAMILY', 'NO_INVOICE');
CREATE TYPE "MembershipFeeProrationRule" AS ENUM ('NONE', 'REMAINING_MONTHS_INCLUSIVE');

ALTER TABLE "MembershipType"
  ADD COLUMN "publicDescription" TEXT,
  ADD COLUMN "publiclyListed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MembershipAnnualFee" (
  "id" TEXT NOT NULL,
  "membershipTypeId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "billingBasis" "MembershipFeeBillingBasis" NOT NULL,
  "prorationRule" "MembershipFeeProrationRule" NOT NULL DEFAULT 'NONE',
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipAnnualFee_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipAnnualFee_amount_nonnegative" CHECK ("amountCents" >= 0),
  CONSTRAINT "MembershipAnnualFee_date_order" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT "MembershipAnnualFee_no_invoice_zero" CHECK ("billingBasis" <> 'NO_INVOICE' OR "amountCents" = 0),
  CONSTRAINT "MembershipAnnualFee_membershipTypeId_fkey" FOREIGN KEY ("membershipTypeId") REFERENCES "MembershipType"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MembershipAnnualFee_membershipTypeId_effectiveFrom_key"
  ON "MembershipAnnualFee"("membershipTypeId", "effectiveFrom");
CREATE INDEX "MembershipAnnualFee_membershipTypeId_effectiveFrom_effectiveTo_idx"
  ON "MembershipAnnualFee"("membershipTypeId", "effectiveFrom", "effectiveTo");
ALTER TABLE "MembershipAnnualFee" ADD CONSTRAINT "MembershipAnnualFee_no_overlap"
  EXCLUDE USING gist (
    "membershipTypeId" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&
  );

CREATE TABLE "EntranceFee" (
  "id" TEXT NOT NULL,
  "category" "EntranceFeeCategory" NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EntranceFee_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EntranceFee_amount_nonnegative" CHECK ("amountCents" >= 0),
  CONSTRAINT "EntranceFee_date_order" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX "EntranceFee_category_effectiveFrom_key"
  ON "EntranceFee"("category", "effectiveFrom");
CREATE INDEX "EntranceFee_category_effectiveFrom_effectiveTo_idx"
  ON "EntranceFee"("category", "effectiveFrom", "effectiveTo");
ALTER TABLE "EntranceFee" ADD CONSTRAINT "EntranceFee_no_overlap"
  EXCLUDE USING gist (
    "category" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::date), '[]') WITH &&
  );

ALTER TABLE "FamilyGroup" ADD COLUMN "billingMemberId" TEXT;
CREATE INDEX "FamilyGroup_billingMemberId_idx" ON "FamilyGroup"("billingMemberId");
ALTER TABLE "FamilyGroup" ADD CONSTRAINT "FamilyGroup_billingMemberId_fkey"
  FOREIGN KEY ("billingMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the new authority from granular entrance mappings. CURRENT_DATE is
-- an honest migration boundary; old mappings did not retain historical dates.
INSERT INTO "EntranceFee" ("id", "category", "amountCents", "effectiveFrom", "updatedAt")
SELECT
  'entrance-fee-backfill-' || lower(e."entranceFeeCategory"::text),
  e."entranceFeeCategory",
  e."amountCents",
  CURRENT_DATE,
  timezone('UTC', statement_timestamp())
FROM "XeroItemCodeMapping" e
WHERE e."category" = 'ENTRANCE_FEE'
  AND e."entranceFeeCategory" IS NOT NULL
  AND e."amountCents" IS NOT NULL
  AND e."amountCents" >= 0
ON CONFLICT ("category", "effectiveFrom") DO NOTHING;

-- The old flat amount applied to every category lacking a granular row.
WITH legacy_text AS (
  SELECT "code"
  FROM "XeroAccountMapping"
  WHERE "key" = 'entranceFeeAmountCents'
    AND "code" ~ '^[0-9]{1,10}$'
), legacy AS (
  SELECT "code"::bigint AS amount
  FROM legacy_text
  WHERE "code"::bigint <= 2147483647
), categories AS (
  SELECT unnest(enum_range(NULL::"EntranceFeeCategory")) AS category
)
INSERT INTO "EntranceFee" ("id", "category", "amountCents", "effectiveFrom", "updatedAt")
SELECT
  'entrance-fee-legacy-' || lower(c.category::text),
  c.category,
  l.amount::integer,
  CURRENT_DATE,
  timezone('UTC', statement_timestamp())
FROM categories c
CROSS JOIN legacy l
WHERE NOT EXISTS (
  SELECT 1 FROM "EntranceFee" f WHERE f."category" = c.category
)
ON CONFLICT ("category", "effectiveFrom") DO NOTHING;

-- A billing member must remain in the same family. PostgreSQL 15+ permits a
-- column-specific SET NULL action, preserving the FamilyGroup primary key while
-- clearing only the optional billing recipient on every join-row removal path.
ALTER TABLE "FamilyGroup" ADD CONSTRAINT "FamilyGroup_billing_membership_fkey"
  FOREIGN KEY ("id", "billingMemberId")
  REFERENCES "FamilyGroupMember"("familyGroupId", "memberId")
  ON DELETE SET NULL ("billingMemberId");
