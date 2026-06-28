-- Add editable member-facing booking messages and Internet Banking payment policy.
-- Defaults preserve existing behaviour: Internet Banking does not hold slots and
-- has no check-in lead-time cutoff until an admin changes the singleton row.

ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "internetBankingHoldSlots" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "internetBankingHoldUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "internetBankingHoldReleasedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Payment_source_status_internetBankingHoldUntil_idx"
  ON "Payment"("source", "status", "internetBankingHoldUntil");

CREATE TABLE IF NOT EXISTS "BookingMessageOverride" (
  "id" TEXT NOT NULL,
  "messageKey" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL,
  "updatedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingMessageOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookingMessageOverride_messageKey_key"
  ON "BookingMessageOverride"("messageKey");

CREATE INDEX IF NOT EXISTS "BookingMessageOverride_updatedByMemberId_idx"
  ON "BookingMessageOverride"("updatedByMemberId");

CREATE TABLE IF NOT EXISTS "InternetBankingPaymentSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "holdBedSlots" BOOLEAN NOT NULL DEFAULT false,
  "holdDays" INTEGER NOT NULL DEFAULT 3,
  "minimumDaysBeforeCheckIn" INTEGER NOT NULL DEFAULT 0,
  "updatedByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InternetBankingPaymentSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InternetBankingPaymentSettings_updatedByMemberId_idx"
  ON "InternetBankingPaymentSettings"("updatedByMemberId");
