-- #1961 (follow-up to E8 #1934): persist server-side dry-run provenance so the
-- Xero member-grouping bulk re-sync can enforce dry-run freshness independent of
-- any client-asserted flag.
--
-- DB-only and idempotent. ZERO Xero calls. One new table keyed by cuid; the
-- bulk re-sync references a row here and re-validates its cache cursor + rule
-- fingerprint at execution start.

CREATE TABLE IF NOT EXISTS "XeroMemberGroupingDryRun" (
  "id" TEXT NOT NULL,
  "mode" "XeroMemberGroupingMode" NOT NULL,
  "cacheCursorAt" TIMESTAMP(3) NOT NULL,
  "rulesFingerprint" TEXT NOT NULL,
  "plannedDigest" TEXT NOT NULL,
  "mismatchCount" INTEGER NOT NULL,
  "addCount" INTEGER NOT NULL,
  "removeCount" INTEGER NOT NULL,
  -- Server-set claim marker (#1961): stamped once, atomically, when the bulk
  -- re-sync is INITIATED from this dry-run. NULL = never started. Distinguishes a
  -- legitimate resume (afterMemberId against a started run) from a forged
  -- first-call resume, and lets a status-guarded claim reject double-initiates.
  "startedAt" TIMESTAMP(3),
  "createdByMemberId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "XeroMemberGroupingDryRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "XeroMemberGroupingDryRun_createdAt_idx"
  ON "XeroMemberGroupingDryRun"("createdAt");

CREATE INDEX IF NOT EXISTS "XeroMemberGroupingDryRun_createdByMemberId_idx"
  ON "XeroMemberGroupingDryRun"("createdByMemberId");
