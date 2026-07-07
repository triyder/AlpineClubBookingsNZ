-- Phase 2 expand release (docs/multi-lodge/implementation-plan.md, ADR-001):
-- nullable lodgeId on the lodge-scoped entity tables plus soft-link lodgeId on
-- the settings singletons, backfilled to the club's sole lodge. Old code
-- ignores the nullable columns entirely. NOT NULL enforcement and per-lodge
-- unique re-scoping follow in a separate contract release once every writer
-- sets lodgeId. Nullable ADD COLUMN with no default is metadata-only; the
-- Booking foreign key is added NOT VALID then validated so existing-row
-- validation never blocks concurrent booking writes.

-- AlterTable
ALTER TABLE "BedAllocationSettings" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "BookingDefaults" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "BookingPeriod" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "BookingRequestSettings" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "CancellationPolicy" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "ChoreTemplate" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "Locker" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "LodgeRoom" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "LodgeSettings" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "MinimumStayPolicy" ADD COLUMN     "lodgeId" TEXT;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "lodgeId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_lodgeId_idx" ON "Booking"("lodgeId");

-- CreateIndex
CREATE INDEX "BookingPeriod_lodgeId_idx" ON "BookingPeriod"("lodgeId");

-- CreateIndex
CREATE INDEX "CancellationPolicy_lodgeId_idx" ON "CancellationPolicy"("lodgeId");

-- CreateIndex
CREATE INDEX "ChoreTemplate_lodgeId_idx" ON "ChoreTemplate"("lodgeId");

-- CreateIndex
CREATE INDEX "Locker_lodgeId_idx" ON "Locker"("lodgeId");

-- CreateIndex
CREATE INDEX "LodgeRoom_lodgeId_idx" ON "LodgeRoom"("lodgeId");

-- CreateIndex
CREATE INDEX "MinimumStayPolicy_lodgeId_idx" ON "MinimumStayPolicy"("lodgeId");

-- CreateIndex
CREATE INDEX "Season_lodgeId_idx" ON "Season"("lodgeId");

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (NOT VALID + VALIDATE: Booking is a hot table; validation of
-- existing rows runs with SHARE UPDATE EXCLUSIVE so concurrent booking writes
-- are never blocked. Final catalog state is identical to a plain ADD
-- CONSTRAINT.)
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Booking" VALIDATE CONSTRAINT "Booking_lodgeId_fkey";

-- AddForeignKey
ALTER TABLE "LodgeRoom" ADD CONSTRAINT "LodgeRoom_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Locker" ADD CONSTRAINT "Locker_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChoreTemplate" ADD CONSTRAINT "ChoreTemplate_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CancellationPolicy" ADD CONSTRAINT "CancellationPolicy_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPeriod" ADD CONSTRAINT "BookingPeriod_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MinimumStayPolicy" ADD CONSTRAINT "MinimumStayPolicy_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill every existing row to the club's sole lodge (oldest active lodge,
-- falling back to the oldest lodge). Single-lodge deployments have exactly one
-- Lodge row from the phase-1 migration, so this is unambiguous. Policy tables
-- (CancellationPolicy, BookingPeriod, MinimumStayPolicy) are NOT backfilled:
-- their existing rows are the club-wide defaults and null lodgeId is their
-- correct permanent state (ADR-001 resolved question 3).
DO $$
DECLARE
  sole_lodge_id TEXT;
BEGIN
  SELECT id INTO sole_lodge_id FROM "Lodge" WHERE active = true
    ORDER BY "createdAt" ASC, id ASC LIMIT 1;
  IF sole_lodge_id IS NULL THEN
    SELECT id INTO sole_lodge_id FROM "Lodge"
      ORDER BY "createdAt" ASC, id ASC LIMIT 1;
  END IF;
  IF sole_lodge_id IS NULL THEN
    RAISE EXCEPTION 'No Lodge row exists; the phase-1 lodge migration must run first';
  END IF;

  UPDATE "LodgeRoom" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "Locker" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "Season" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "Booking" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "ChoreTemplate" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "LodgeSettings" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "BedAllocationSettings" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "BookingDefaults" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  UPDATE "BookingRequestSettings" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
END $$;
