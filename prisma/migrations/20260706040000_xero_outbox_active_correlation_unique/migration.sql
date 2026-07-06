-- #1354 (owner-approved scope addition, #1375 sitting item 10): defence in depth
-- against concurrent double-enqueue of the same Xero outbox intent — at most ONE
-- ACTIVE operation per correlation key. Terminal rows (SUCCEEDED/FAILED/
-- CANCELLED/...) legitimately repeat the key across attempts, so this is a
-- PARTIAL unique index over the active statuses only; the findFirst dedup in the
-- enqueue paths stays the fast path, and startXeroSyncOperation resolves a lost
-- race by returning the winner's row. (Same raw-partial-index pattern as
-- Member_email_login_unique — prisma migrate diff tolerates these.)
CREATE UNIQUE INDEX IF NOT EXISTS "XeroSyncOperation_active_correlationKey_unique"
ON "XeroSyncOperation" ("correlationKey")
WHERE "correlationKey" IS NOT NULL
  AND "status" IN ('PENDING', 'RUNNING', 'WAITING_PAYMENT');
