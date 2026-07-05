-- Item 3 of #1208 / #1271: promote the Xero outbox queue type to a
-- denormalized, indexed first-class column on "XeroSyncOperation".
--
-- The value stays canonical inside requestPayload->>'queueType' (the payload
-- parsing switch in xero-operation-outbox-payload.ts keeps switching on it);
-- this column is a denormalized COPY only. Making it the sole source (dropping
-- the payload read) is deferred to #1272. queueType is set at enqueue and is
-- immutable thereafter, so the column never desyncs from the payload.

-- 1. Add the nullable column. Nullable because REQUEUE, BACKFILL, inbound
--    reconcile, and other non-outbox rows legitimately carry no queueType.
ALTER TABLE "XeroSyncOperation" ADD COLUMN "queueType" TEXT;

-- 2. Backfill existing rows from the canonical JSONB payload field. "?" tests
--    for key presence; "->>" extracts the text value. Rows without the key
--    (REQUEUE / BACKFILL / inbound) are left NULL.
UPDATE "XeroSyncOperation"
SET "queueType" = "requestPayload" ->> 'queueType'
WHERE "requestPayload" IS NOT NULL
  AND "requestPayload" ? 'queueType';

-- 3. Composite index matching the pending-outbox scan predicates
--    (queueType + status, ordered by createdAt). Name mirrors Prisma's
--    generated index name for @@index([queueType, status, createdAt]).
CREATE INDEX "XeroSyncOperation_queueType_status_createdAt_idx"
  ON "XeroSyncOperation" ("queueType", "status", "createdAt");
