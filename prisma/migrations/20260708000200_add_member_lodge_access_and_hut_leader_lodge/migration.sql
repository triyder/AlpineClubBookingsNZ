-- Phase 4 expand release (docs/multi-lodge/implementation-plan.md, ADR-001
-- resolved questions 2 and 5): the MemberLodgeAccess grant table
-- (BOOKING_RESTRICTION rows restrict a member to the listed lodges, no rows =
-- default-open; STAFF rows bind kiosk accounts to a lodge) and a nullable
-- lodgeId on HutLeaderAssignment (null = the club's default lodge until the
-- contract release enforces NOT NULL). Old code ignores the new table and
-- column entirely. Existing hut-leader assignments are backfilled to the sole
-- lodge, matching the phase-2 entity backfill.

-- CreateEnum
CREATE TYPE "LodgeAccessKind" AS ENUM ('BOOKING_RESTRICTION', 'STAFF');

-- AlterTable
ALTER TABLE "HutLeaderAssignment" ADD COLUMN     "lodgeId" TEXT;

-- CreateTable
CREATE TABLE "MemberLodgeAccess" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "kind" "LodgeAccessKind" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberLodgeAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberLodgeAccess_lodgeId_idx" ON "MemberLodgeAccess"("lodgeId");

-- CreateIndex
CREATE INDEX "MemberLodgeAccess_memberId_kind_idx" ON "MemberLodgeAccess"("memberId", "kind");

-- CreateIndex
CREATE INDEX "MemberLodgeAccess_createdById_idx" ON "MemberLodgeAccess"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "MemberLodgeAccess_memberId_lodgeId_kind_key" ON "MemberLodgeAccess"("memberId", "lodgeId", "kind");

-- CreateIndex
CREATE INDEX "HutLeaderAssignment_lodgeId_idx" ON "HutLeaderAssignment"("lodgeId");

-- AddForeignKey
ALTER TABLE "HutLeaderAssignment" ADD CONSTRAINT "HutLeaderAssignment_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberLodgeAccess" ADD CONSTRAINT "MemberLodgeAccess_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberLodgeAccess" ADD CONSTRAINT "MemberLodgeAccess_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberLodgeAccess" ADD CONSTRAINT "MemberLodgeAccess_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing assignments to the club's sole lodge (oldest active,
-- falling back to oldest), mirroring the phase-2 entity backfill.
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
  IF sole_lodge_id IS NOT NULL THEN
    UPDATE "HutLeaderAssignment" SET "lodgeId" = sole_lodge_id WHERE "lodgeId" IS NULL;
  END IF;
END $$;
