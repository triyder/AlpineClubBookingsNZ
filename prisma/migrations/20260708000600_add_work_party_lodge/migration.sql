-- AlterTable
ALTER TABLE "WorkPartyEvent" ADD COLUMN     "lodgeId" TEXT;

-- CreateIndex
CREATE INDEX "WorkPartyEvent_lodgeId_idx" ON "WorkPartyEvent"("lodgeId");

-- AddForeignKey
ALTER TABLE "WorkPartyEvent" ADD CONSTRAINT "WorkPartyEvent_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

