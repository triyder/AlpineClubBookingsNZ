-- DropIndex
DROP INDEX "Locker_name_key";

-- DropIndex
DROP INDEX "LodgeRoom_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Locker_lodgeId_name_key" ON "Locker"("lodgeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "LodgeRoom_lodgeId_name_key" ON "LodgeRoom"("lodgeId", "name");

