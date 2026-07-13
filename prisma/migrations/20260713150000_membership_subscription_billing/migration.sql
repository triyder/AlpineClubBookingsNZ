-- Additive, blue/green-safe membership subscription billing foundation (#1857).
-- Old application versions ignore all new enums and tables.
CREATE TYPE "MembershipSubscriptionChargeSource" AS ENUM ('ANNUAL_BATCH', 'NEW_MEMBER_APPROVAL');
CREATE TYPE "MembershipSubscriptionChargeStatus" AS ENUM ('NOT_REQUIRED', 'QUEUED', 'PROCESSING', 'INVOICE_CREATED', 'EMAIL_FAILED', 'EMAILED', 'CONFLICT');
CREATE TYPE "MembershipBillingExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "MembershipSubscriptionCharge" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "seasonYear" INTEGER NOT NULL,
  "source" "MembershipSubscriptionChargeSource" NOT NULL,
  "status" "MembershipSubscriptionChargeStatus" NOT NULL DEFAULT 'QUEUED',
  "membershipAnnualFeeId" TEXT,
  "membershipTypeId" TEXT NOT NULL,
  "membershipTypeKey" TEXT NOT NULL,
  "membershipTypeName" TEXT NOT NULL,
  "billingBasis" "MembershipFeeBillingBasis" NOT NULL,
  "prorationRule" "MembershipFeeProrationRule" NOT NULL,
  "annualAmountCents" INTEGER NOT NULL,
  "chargedAmountCents" INTEGER NOT NULL,
  "coveredMonths" INTEGER NOT NULL,
  "decisionDate" DATE NOT NULL,
  "coverageStart" DATE NOT NULL,
  "coverageEnd" DATE NOT NULL,
  "familyGroupId" TEXT,
  "recipientMemberId" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "dueDays" INTEGER NOT NULL,
  "xeroAccountCode" TEXT,
  "xeroItemCode" TEXT,
  "invoiceReference" TEXT NOT NULL,
  "xeroInvoiceId" TEXT,
  "xeroInvoiceNumber" TEXT,
  "xeroInvoiceUrl" TEXT,
  "xeroInvoiceAdopted" BOOLEAN NOT NULL DEFAULT false,
  "invoicePersistedAt" TIMESTAMP(3),
  "emailAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "emailLastAttemptAt" TIMESTAMP(3),
  "emailSentAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "confirmedByMemberId" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipSubscriptionCharge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipSubscriptionCharge_amounts_check" CHECK ("annualAmountCents" >= 0 AND "chargedAmountCents" >= 0),
  CONSTRAINT "MembershipSubscriptionCharge_months_check" CHECK ("coveredMonths" >= 1 AND "coveredMonths" <= 12),
  CONSTRAINT "MembershipSubscriptionCharge_due_days_check" CHECK ("dueDays" >= 1 AND "dueDays" <= 365),
  CONSTRAINT "MembershipSubscriptionCharge_no_invoice_zero_check" CHECK ("billingBasis" <> 'NO_INVOICE' OR "chargedAmountCents" = 0)
);

CREATE TABLE "MembershipSubscriptionChargeCoverage" (
  "id" TEXT NOT NULL,
  "chargeId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "memberName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipSubscriptionChargeCoverage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipBillingException" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "seasonYear" INTEGER NOT NULL,
  "source" "MembershipSubscriptionChargeSource" NOT NULL,
  "status" "MembershipBillingExceptionStatus" NOT NULL DEFAULT 'OPEN',
  "code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "memberId" TEXT,
  "familyGroupId" TEXT,
  "membershipTypeId" TEXT,
  "context" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipBillingException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipSubscriptionBillingSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "invoiceDueDays" INTEGER NOT NULL DEFAULT 30,
  "updatedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipSubscriptionBillingSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipSubscriptionBillingSettings_due_days_check" CHECK ("invoiceDueDays" >= 1 AND "invoiceDueDays" <= 365)
);

CREATE UNIQUE INDEX "MembershipSubscriptionCharge_idempotencyKey_key" ON "MembershipSubscriptionCharge"("idempotencyKey");
CREATE UNIQUE INDEX "MembershipSubscriptionCharge_invoiceReference_key" ON "MembershipSubscriptionCharge"("invoiceReference");
CREATE UNIQUE INDEX "MembershipSubscriptionCharge_xeroInvoiceId_key" ON "MembershipSubscriptionCharge"("xeroInvoiceId");
CREATE UNIQUE INDEX "MembershipCharge_family_type_year_key" ON "MembershipSubscriptionCharge"("seasonYear", "membershipTypeId", "familyGroupId");
CREATE INDEX "MembershipSubscriptionCharge_seasonYear_status_createdAt_idx" ON "MembershipSubscriptionCharge"("seasonYear", "status", "createdAt");
CREATE INDEX "MembershipSubscriptionCharge_recipientMemberId_seasonYear_idx" ON "MembershipSubscriptionCharge"("recipientMemberId", "seasonYear");
CREATE INDEX "MembershipSubscriptionCharge_familyGroupId_seasonYear_idx" ON "MembershipSubscriptionCharge"("familyGroupId", "seasonYear");
CREATE UNIQUE INDEX "MembershipSubscriptionChargeCoverage_subscriptionId_key" ON "MembershipSubscriptionChargeCoverage"("subscriptionId");
CREATE UNIQUE INDEX "MembershipChargeCoverage_charge_subscription_key" ON "MembershipSubscriptionChargeCoverage"("chargeId", "subscriptionId");
CREATE INDEX "MembershipSubscriptionChargeCoverage_chargeId_idx" ON "MembershipSubscriptionChargeCoverage"("chargeId");
CREATE INDEX "MembershipSubscriptionChargeCoverage_memberId_createdAt_idx" ON "MembershipSubscriptionChargeCoverage"("memberId", "createdAt");
CREATE UNIQUE INDEX "MembershipBillingException_fingerprint_key" ON "MembershipBillingException"("fingerprint");
CREATE INDEX "MembershipBillingException_status_seasonYear_lastSeenAt_idx" ON "MembershipBillingException"("status", "seasonYear", "lastSeenAt");
CREATE INDEX "MembershipBillingException_memberId_status_idx" ON "MembershipBillingException"("memberId", "status");
CREATE INDEX "MembershipBillingException_familyGroupId_status_idx" ON "MembershipBillingException"("familyGroupId", "status");

ALTER TABLE "MembershipSubscriptionCharge" ADD CONSTRAINT "MembershipSubscriptionCharge_recipientMemberId_fkey" FOREIGN KEY ("recipientMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionCharge" ADD CONSTRAINT "MembershipSubscriptionCharge_confirmedByMemberId_fkey" FOREIGN KEY ("confirmedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionChargeCoverage" ADD CONSTRAINT "MembershipSubscriptionChargeCoverage_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "MembershipSubscriptionCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MembershipSubscriptionChargeCoverage" ADD CONSTRAINT "MembershipSubscriptionChargeCoverage_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "MemberSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MembershipBillingException" ADD CONSTRAINT "MembershipBillingException_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
