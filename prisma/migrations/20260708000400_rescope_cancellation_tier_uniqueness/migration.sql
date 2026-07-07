-- DropIndex
DROP INDEX "CancellationPolicy_daysBeforeStay_key";

-- CreateIndex
CREATE UNIQUE INDEX "CancellationPolicy_lodgeId_daysBeforeStay_key" ON "CancellationPolicy"("lodgeId", "daysBeforeStay");

