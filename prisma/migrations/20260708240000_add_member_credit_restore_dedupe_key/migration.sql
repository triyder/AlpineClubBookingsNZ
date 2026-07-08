-- #1636: structural dedupe for restoreCreditFromBooking. A restore row reverses a
-- booking's applied account credit; at most ONE may legitimately exist per source
-- booking (a partial restore writes a single row, the remainder is forfeited).
-- Until now that "one restore per booking" guarantee rested entirely on the
-- callers' shared pg_advisory_xact_lock(1) + status guard. This nullable, unique
-- natural key makes a second restore INSERT for the same booking structurally
-- impossible, independent of caller lock granularity.
--
-- A dedicated column (NOT the shared sourceBookingId) is required because
-- sourceBookingId + type=CANCELLATION_REFUND is written by THREE legitimate credit
-- paths for one booking — restoreCreditFromBooking, createCancellationCredit (the
-- held-as-credit refund of the paid slice) and the Xero inbound
-- invoice-paid-effects (late Internet-Banking cash on a cancelled booking) — so a
-- unique over (sourceBookingId, type) would reject those legitimately co-occurring
-- rows. Only restore rows set restoredFromBookingId, so the unique constraint
-- scopes exactly to the restore operation.
--
-- EXPAND-only. The nullable ADD COLUMN (no default) is a metadata-only catalog
-- change (brief ACCESS EXCLUSIVE lock, no rewrite, no row scan). The CREATE UNIQUE
-- INDEX over the all-NULL new column scans MemberCredit to build the index, but
-- every existing row is NULL so no uniqueness conflict is possible and the build
-- is fast (MemberCredit is not a high-write hot table). No backfill: existing
-- restore rows stay NULL, which is safe — their only re-restore vector
-- (orphaned-applied-credit backfill) is already blocked by its CANCELLATION_REFUND
-- predicate. Old app colours never read or write this column, so the draining
-- previous colour is fully compatible during the blue/green window.

-- AlterTable
ALTER TABLE "MemberCredit" ADD COLUMN "restoredFromBookingId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MemberCredit_restoredFromBookingId_key" ON "MemberCredit"("restoredFromBookingId");
