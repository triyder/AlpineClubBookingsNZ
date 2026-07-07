-- DropIndex
DROP INDEX "LodgeInstruction_key_key";

-- AlterTable
ALTER TABLE "LodgeInstruction" ADD COLUMN     "lodgeId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LodgeInstruction_lodgeId_key_key" ON "LodgeInstruction"("lodgeId", "key");

-- AddForeignKey
ALTER TABLE "LodgeInstruction" ADD CONSTRAINT "LodgeInstruction_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

