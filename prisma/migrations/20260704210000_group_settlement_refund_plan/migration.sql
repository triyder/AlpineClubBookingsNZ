-- Persist the per-child organiser-cancel refund plan so a crash-interrupted
-- re-drive applies the recorded amounts instead of recomputing (tier drift is
-- unsafe across a >24h re-drive). New nullable column: no backfill. #1236
ALTER TABLE "GroupBookingSettlement" ADD COLUMN "refundPlan" JSONB;
