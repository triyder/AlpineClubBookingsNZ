-- CreateEnum
CREATE TYPE "ContactEmailMode" AS ENUM ('ROLE', 'MEMBER', 'CUSTOM');

-- AlterTable
ALTER TABLE "CommitteeAssignment" ADD COLUMN     "contactEmailMode" "ContactEmailMode" NOT NULL DEFAULT 'ROLE',
ADD COLUMN     "contactEmailOverride" TEXT;

