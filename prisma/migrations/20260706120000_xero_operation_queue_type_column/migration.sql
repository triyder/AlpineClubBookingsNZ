-- Item 3 of #1208 / #1271: promote the Xero outbox queue type to a
-- denormalized, indexed first-class column on "XeroSyncOperation".
--
-- Denormalized copy of the outbox discriminator, captured once at enqueue in
-- startXeroSyncOperation and never updated afterward. requestPayload->>'queueType'
-- stays canonical (the payload parsing switch keeps switching on it); this
-- column is a COPY only, and making it the sole source is deferred to #1272.
-- Dispatch reads queueType from requestPayload (not this column), BEFORE handlers
-- may overwrite requestPayload -- so after dispatch this column can diverge from
-- the payload (some handlers rewrite requestPayload wholesale and drop
-- queueType). That is expected and safe: nothing reads this column yet, and for
-- every row still awaiting dispatch (PENDING / WAITING_PAYMENT -- the set #1272
-- will scan) the column faithfully mirrors the enqueue-time queueType. The
-- backfill below captures that same value for existing rows.

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
