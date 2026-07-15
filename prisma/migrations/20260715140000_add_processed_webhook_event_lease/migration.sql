-- F16 webhook dedup lease (issue #1887). Additive, expand-only: two new columns
-- on ProcessedWebhookEvent turn the dedup claim into a processing lease so a
-- crashed or concurrently-failing handler can no longer silently drop a webhook
-- event. Old-colour compatible during a blue/green deploy — the previous release
-- neither reads nor writes these columns, and both carry constant/now() defaults,
-- so its inserts keep working (they land as "PROCESSING" and are safely
-- reprocessed by the new colour on redelivery rather than ACKed as done).

-- AlterTable: new columns default so existing and old-colour rows are valid.
ALTER TABLE "ProcessedWebhookEvent"
  ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  ADD COLUMN     "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: every pre-migration row is a historically fully-processed event, so
-- mark them COMPLETED. New inserts (new-colour code) set "PROCESSING" explicitly
-- and flip to "COMPLETED" on success; the column default only ever covers an
-- old-colour insert mid-deploy, which must reprocess rather than drop.
UPDATE "ProcessedWebhookEvent" SET "status" = 'COMPLETED';
