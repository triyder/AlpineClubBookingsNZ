-- Operator override for Xero sync operations that were resolved directly in
-- Xero. When "manuallyResolvedAt" is set, the operation is excluded from the
-- active-failure overview and the stuck-state dashboard count. Additive and
-- nullable, so existing rows are unaffected.
ALTER TABLE "XeroSyncOperation"
  ADD COLUMN IF NOT EXISTS "manuallyResolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "manuallyResolvedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "manuallyResolvedById" TEXT;

CREATE INDEX IF NOT EXISTS "XeroSyncOperation_status_manuallyResolvedAt_idx" ON "XeroSyncOperation"("status", "manuallyResolvedAt");
