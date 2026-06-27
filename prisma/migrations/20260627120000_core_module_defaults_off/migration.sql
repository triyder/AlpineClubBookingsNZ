-- After removing FEATURE_* environment gates, high-risk capability modules must
-- not become active merely because the historical singleton row defaulted them
-- to true. General-purpose modules stay default-on; admins explicitly enable
-- these capability modules from Admin > Modules after provider/setup readiness.
ALTER TABLE "ClubModuleSettings"
  ALTER COLUMN "kiosk" SET DEFAULT false,
  ALTER COLUMN "chores" SET DEFAULT false,
  ALTER COLUMN "financeDashboard" SET DEFAULT false,
  ALTER COLUMN "waitlist" SET DEFAULT false,
  ALTER COLUMN "xeroIntegration" SET DEFAULT false,
  ALTER COLUMN "bedAllocation" SET DEFAULT false,
  ALTER COLUMN "internetBankingPayments" SET DEFAULT false;

-- Preserve any row an admin has already saved. The migration only repairs the
-- untouched default row created by earlier migrations.
UPDATE "ClubModuleSettings"
SET
  "kiosk" = false,
  "chores" = false,
  "financeDashboard" = false,
  "waitlist" = false,
  "xeroIntegration" = false,
  "bedAllocation" = false,
  "internetBankingPayments" = false,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'default'
  AND "updatedByMemberId" IS NULL;
