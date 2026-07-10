-- CreateEnum
CREATE TYPE "BedType" AS ENUM ('SINGLE', 'BUNK_TOP', 'BUNK_BOTTOM', 'DOUBLE');

-- AlterTable
ALTER TABLE "LodgeBed" ADD COLUMN     "bedType" "BedType" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "bunkGroup" VARCHAR(50);

