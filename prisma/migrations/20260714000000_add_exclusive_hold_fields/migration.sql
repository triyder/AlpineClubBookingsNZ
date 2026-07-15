-- Exclusive whole-lodge hold (#117 / epic #116, ADR-001). Additive, expand-only:
-- new columns carry constant defaults (metadata-only for the booleans), plus a
-- nullable audit FK + its index. Old-colour compatible — the previous release
-- neither reads nor writes these columns, so it keeps working during a
-- blue/green deploy.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "wholeLodgeHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wholeLodgeHoldAt" TIMESTAMP(3),
ADD COLUMN     "wholeLodgeHoldByMemberId" TEXT;

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "exclusivityRequested" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Booking_wholeLodgeHoldByMemberId_idx" ON "Booking"("wholeLodgeHoldByMemberId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_wholeLodgeHoldByMemberId_fkey" FOREIGN KEY ("wholeLodgeHoldByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
